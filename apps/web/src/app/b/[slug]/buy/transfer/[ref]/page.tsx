import { Heading } from "@/components/ui/heading";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyLinkButton } from "@/components/copy-link-button";
import { formatMinorUnits } from "@/lib/money";
import { buildPayeeInstructions } from "@/lib/payments/payee-instructions";
import { INSTRUMENT_SELECT } from "@/lib/payments/instruments";
import { markTransferPaymentSentAction } from "@/app/actions/transfer-mark-sent";
import { getPublicFunnelT } from "@/lib/i18n";
import { funnelLocaleForSlug } from "@/lib/booking/funnel-locale";
import { clientIp, rateLimit } from "@/lib/rate-limit";

// Manual-transfer checkout instructions. Reached via:
//   POST /actions/checkout (paymentMethod=manual_transfer) → redirect →
//   GET /b/[slug]/buy/transfer/[ref]
// The pre-D-113 path /b/[slug]/buy/wise/[ref] permanently redirects here.
//
// Every instrument shares the frame — amount, reference, "I've sent it" — and
// differs only in step 1, the payee instructions themselves. That split is the
// whole point of D-113: Wise supplies a prefilled Quick-Pay URL where SPEI
// supplies a CLABE the student types into their banking app, and neither is
// "the rail".
//
// We render `payment_status === paid` defensively in case the teacher
// confirmed before the student opened this URL — the student gets the
// "active" state without a refresh.

export const dynamic = "force-dynamic";

// Per-payment-reference URLs — never indexable.
export const metadata: Metadata = {
  robots: { index: false, follow: true },
};

export default async function TransferInstructionsPage({
  params,
}: {
  params: Promise<{ slug: string; ref: string }>;
}) {
  const { slug, ref } = await params;
  const t = getPublicFunnelT(await funnelLocaleForSlug(slug));

  // Security audit M-8. This page renders the teacher's payee details — an
  // account-holder name and email, or a CLABE — real PII sitting behind a
  // reference that is guessable only by entropy, at a URL whose slug half is
  // public by design. The reference was widened to 48 bits for exactly this
  // reason (lib/payments/reference.ts). The SPEI instrument raises the stakes:
  // a CLABE is a bank account number, so an unthrottled oracle here would leak
  // more than a display name, which is what the scope and limit here bound.
  const rl = await rateLimit(await clientIp(), {
    scope: "transfer-instructions-ip",
    limit: 15,
    windowMs: 60_000,
  });
  // notFound() rather than a distinct 429: a throttled prober should not be
  // able to tell "slow down, this reference exists" from "no such reference".
  if (!rl.ok) notFound();

  const payment = await prisma.payment.findFirst({
    where: {
      provider: "manual_transfer",
      paymentReference: ref,
      package: { teacher: { bookingSlug: slug } },
    },
    include: {
      // The instrument the student was SHOWN, not whatever the teacher has on
      // file now. Re-reading her current details here would silently move the
      // payee under a student who already sent the money.
      instrument: { select: INSTRUMENT_SELECT },
      package: {
        select: {
          status: true,
          classesTotal: true,
          classDurationMin: true,
          template: { select: { name: true } },
          teacher: { select: { name: true } },
          student: { select: { name: true, email: true } },
        },
      },
    },
  });

  if (!payment || !payment.paymentReference || !payment.instrument) notFound();
  // If the teacher disabled this instrument after the student created the
  // intent we still let them complete this run — the reference is unique and
  // she can still mark it paid. What we can't render is an instrument with no
  // payee detail at all, so that 404s.
  const instrument = payment.instrument;

  // Per-kind copy. The frame (amount, reference, "I've sent it", the paid
  // branch) is shared; only step 1 and the strings naming the instrument
  // differ, so the keys are selected once here rather than branched at each
  // use site.
  const isWise = instrument.kind === "wise";
  const confirmedBodyKey = isWise
    ? "web.wiseInstructions.confirmedBody"
    : "web.bankInstructions.confirmedBody";

  // Already paid? Bounce to the result page so the success/refund branch
  // owns the rendering. This is a thin redirect, not a duplicate view.
  if (payment.status === "paid" || payment.status === "refunded") {
    return (
      <main className="container max-w-lg space-y-6 py-10">
        <Card>
          <CardHeader>
            <CardTitle>{t("web.buyResult.header.paid")}</CardTitle>
            <CardDescription>
              {payment.package.student.name} · {payment.package.student.email}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              {t(confirmedBodyKey, {
                amount: formatMinorUnits(payment.amountMinorUnits, payment.currency),
              })}
            </p>
            <p>
              <Link href="/my-classes" className="underline">
                {t("book.confirm.viewMine")}
              </Link>
            </p>
          </CardContent>
        </Card>
      </main>
    );
  }

  const teacher = payment.package.teacher;
  // Falls back to the teacher's own name: `accountHolder` is optional, but the
  // student still needs a human to recognize as the payee.
  const amountStr = formatMinorUnits(payment.amountMinorUnits, payment.currency);

  // The payee block, built by one shared function — so a student always sees
  // the same set of fields, in the same order, formatted the same way. A bank
  // account has no hosted page to hand
  // off to: the student types these values into their own bank, which is why
  // each one is rendered grouped and copyable rather than as prose.
  const instructions = buildPayeeInstructions({
    instrument,
    amountMinorUnits: payment.amountMinorUnits,
    currency: payment.currency,
    reference: payment.paymentReference,
    fallbackRecipientName: teacher.name,
  });
  // Nothing payable on the instrument — a 404 rather than a half-filled page
  // a student might act on.
  if (!instructions) notFound();
  const payeeName = instructions.recipientName;
  const wiseUrl = instructions.wisePayUrl;

  return (
    <main className="container max-w-lg space-y-6 py-10">
      <header>
        <Heading level={2} as="h1">
          {t(isWise ? "web.wiseInstructions.title" : "web.bankInstructions.title")}
        </Heading>
        <p className="text-muted-foreground mt-1 text-sm">
          {payment.package.template?.name ?? t("web.wiseInstructions.package")} ·{" "}
          {t("web.wiseInstructions.classesOf", {
            count: payment.package.classesTotal,
            min: payment.package.classDurationMin,
          })}
        </p>
      </header>

      {isWise ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.wiseInstructions.step1.title")}</CardTitle>
            <CardDescription>{t("web.wiseInstructions.step1.body")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <dl className="space-y-3">
              <Row label={t("web.wiseInstructions.amountToSend")} value={amountStr} highlight />
              <Row label={t("buy.wise.recipient")} value={payeeName} />
              {instrument.wiseEmail && (
                <Row
                  label={t("web.wiseInstructions.wiseEmail")}
                  value={instrument.wiseEmail}
                  mono
                />
              )}
            </dl>
            <Button asChild className="w-full">
              <a href={wiseUrl ?? "#"} target="_blank" rel="noreferrer noopener">
                {t("buy.wise.payNow")}
              </a>
            </Button>
            <p className="text-muted-foreground text-xs">{t("web.wiseInstructions.step1.hint")}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("web.bankInstructions.step1.title")}</CardTitle>
            <CardDescription>{t("web.bankInstructions.step1.body")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <dl className="space-y-3">
              <Row label={t("web.bankInstructions.amountToSend")} value={amountStr} highlight />
              <Row label={t("web.bankInstructions.beneficiaryLabel")} value={payeeName} />
            </dl>
            {/* One block per field the account's own scheme declares, grouped,
                selectable and copyable. An unbroken run of digits is the
                format a student most easily mis-reads back, and the copy
                button hands over the CANONICAL value — a banking app that
                rejects spaces would choke on the grouped one. */}
            {instructions.fields.map((field) => (
              <div key={field.labelKey}>
                <p className="text-muted-foreground mb-1 text-xs">{t(field.labelKey)}</p>
                <div className="bg-muted/40 rounded-md border px-3 py-2 font-mono text-sm break-all select-all lg:text-base">
                  {field.display}
                </div>
              </div>
            ))}
            <CopyLinkButton
              value={instructions.fields.map((f) => f.copy).join("\n")}
              label={t("web.bankInstructions.copyClabe")}
              toastMessage={t("web.bankInstructions.clabeCopied")}
            />
            <p className="text-muted-foreground text-xs">{t("web.bankInstructions.checkBank")}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {t(isWise ? "web.wiseInstructions.step2.title" : "web.bankInstructions.step2.title")}
          </CardTitle>
          <CardDescription>
            {t(isWise ? "web.wiseInstructions.step2.body" : "web.bankInstructions.step2.body")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="bg-muted/40 rounded-md border px-3 py-2 font-mono text-sm break-all select-all lg:text-base">
            {payment.paymentReference}
          </div>
          <CopyLinkButton
            value={payment.paymentReference}
            label={t("web.wiseInstructions.copyReference")}
            toastMessage={t("web.wiseInstructions.referenceCopied")}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {t(isWise ? "web.wiseInstructions.step3.title" : "web.bankInstructions.step3.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>{t(isWise ? "web.wiseInstructions.step3.body" : "web.bankInstructions.step3.body")}</p>
          <form action={markTransferPaymentSentAction}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="ref" value={payment.paymentReference} />
            <Button type="submit" variant="outline" className="w-full">
              {t("buy.wise.sent")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <footer className="text-muted-foreground border-t pt-4 text-xs">
        {t("web.wiseInstructions.internalReference")}:{" "}
        <span className="font-mono">{payment.externalReference}</span>
      </footer>
    </main>
  );
}

function Row({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`${mono ? "font-mono text-xs" : ""} ${
          highlight ? "text-base font-semibold" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
