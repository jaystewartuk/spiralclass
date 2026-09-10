import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { CalendarClock, Check, Clock, Loader2, X } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getCurrentStudent } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { CopyLinkButton } from "@/components/copy-link-button";
import { Heading } from "@/components/ui/heading";
import { Card, CardContent } from "@/components/ui/card";
import { ResendSignInLink } from "./resend-sign-in-link";
import { formatMinorUnits } from "@/lib/money";
import { getPublicFunnelT } from "@/lib/i18n";
import { funnelLocaleForSlug } from "@/lib/booking/funnel-locale";
import { timeOptionsFor, type AppLocale } from "@spiralclass/shared";

// Stripe redirects here after Checkout with ?ref=<externalReference>.
// back_urls are not the source of truth — the webhook is. We read the
// Payment row by externalReference and render whatever state the webhook
// (or stub) has persisted. Auto-refresh every 5s while pending.
//
// This is the highest-emotion screen in the funnel: a stranger has just sent
// money to a teacher she may never have met. It is laid out as a receipt
// rather than a status dump — a status crest that reads before the words do,
// the next action as a button rather than a sentence, then the two facts she
// will look for later (when her first class is, and what she bought) as
// structured rows she can screenshot.

export const dynamic = "force-dynamic";

// Per-payment token URLs — never indexable.
export const metadata: Metadata = {
  robots: { index: false, follow: true },
};

export default async function ResultadoPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ ref?: string }>;
}) {
  const { slug } = await params;
  const { ref } = await searchParams;
  if (!ref) notFound();
  const locale = await funnelLocaleForSlug(slug);
  const t = getPublicFunnelT(locale);

  const payment = await prisma.payment.findFirst({
    where: {
      externalReference: ref,
      package: { teacher: { bookingSlug: slug } },
    },
    include: {
      package: {
        select: {
          status: true,
          teacherId: true,
          studentId: true,
          // The receipt rows. She bought a named thing from a named person and
          // the credits run out on a date — none of which the page used to say,
          // so the only description of her purchase was the amount.
          classesTotal: true,
          classDurationMin: true,
          expiresAt: true,
          template: { select: { name: true } },
          // Pay-at-reservation intent (D-111): the slot the student picked at
          // checkout — the reservation for a single class, the first class for
          // a package.
          intendedStartUtc: true,
          student: { select: { id: true, email: true, name: true } },
          teacher: { select: { name: true, timezone: true } },
        },
      },
    },
  });
  if (!payment) notFound();

  const pkg = payment.package;
  const isPending = payment.status === "pending";
  const isWise = payment.provider === "manual_transfer";

  // Whether auto-book-on-paid actually landed the intent. The intent alone
  // can't answer it: a slow rail (Wise) can have the slot taken out from under
  // it between paying and confirming, in which case the credit stays bookable
  // and no booking exists. Cancelled rows don't count as landed.
  //
  // Looked up by student + teacher + start, NOT through this package's own
  // bookings: the booking core spends the soonest-to-expire credit across every
  // active package the student holds with this teacher (credit-ledger FIFO), so
  // a top-up bought while an older package is still live lands its first class
  // on the OLDER package. Reading `package.bookings` here told a repeat buyer
  // her class wasn't scheduled when it was. Mirrors the idempotency lookup in
  // lib/booking/auto-book-intended.ts.
  const intendedStart = pkg.intendedStartUtc;
  const landed = intendedStart
    ? await prisma.booking.findFirst({
        where: {
          teacherId: pkg.teacherId,
          studentId: pkg.studentId,
          scheduledStart: intendedStart,
          status: { notIn: ["canceled_by_student", "canceled_by_teacher"] },
        },
        select: { id: true },
      })
    : null;
  const firstClass = intendedStart
    ? {
        startUtc: intendedStart,
        timezone: pkg.teacher.timezone,
        booked: landed !== null,
      }
    : null;

  // Repeat purchases arrive here already signed in (the portal flow at
  // /my-classes/buy redirects through the same Stripe/Wise pages).
  // For them the "we emailed you a sign-in link" copy is wrong — no email
  // is sent after the first payment — so offer the portal directly.
  const currentStudent = await getCurrentStudent();
  const selfSignedIn = currentStudent?.id === pkg.student.id;

  const tone = toneFor(payment.status, isWise);

  return (
    <main className="container max-w-lg space-y-8 py-10 sm:py-14">
      {isPending && !isWise && (
        // Stripe back_urls can land here before the webhook fires.
        // Auto-refresh so the student sees the "paid" state without
        // tapping anything. Wise is teacher-confirmed (no webhook
        // racing the redirect), so the auto-refresh would just spin —
        // we let the student come back when they get the email.
        <meta httpEquiv="refresh" content="5" />
      )}

      {/* The crest reads before the sentence does — colour and shape carry the
          outcome for someone who is scanning, and the heading carries it for
          everyone else. `role="status"` is on the wrapper rather than the
          glyph so the state is announced with its heading, not as a lone
          decorative icon. */}
      <header className="flex flex-col items-center text-center" role="status">
        <StatusCrest tone={tone} />
        <Heading level={1} as="h1" className="mt-5 text-balance">
          {headerCopy(payment.status, isWise, t)}
        </Heading>
        {/* Name only. The email address belongs in the sentence that tells her
            we sent a sign-in link TO it — printed twice, three lines apart, it
            stops being the thing she checks for a typo and becomes chrome. */}
        <p className="mt-3 text-sm text-muted-foreground">{pkg.student.name}</p>
      </header>

      <StatusBody
        status={payment.status}
        isWise={isWise}
        slug={slug}
        studentEmail={pkg.student.email}
        paymentReference={payment.paymentReference}
        selfSignedIn={selfSignedIn}
        firstClass={firstClass}
        classesTotal={pkg.classesTotal}
        t={t}
      />

      {firstClass && (
        <FirstClassCard firstClass={firstClass} locale={locale} status={payment.status} t={t} />
      )}

      <PurchaseSummary
        packageName={pkg.template?.name ?? null}
        classesTotal={pkg.classesTotal}
        classDurationMin={pkg.classDurationMin}
        teacherName={pkg.teacher.name}
        teacherTimezone={pkg.teacher.timezone}
        expiresAt={pkg.expiresAt}
        amountMinorUnits={payment.amountMinorUnits}
        currency={payment.currency}
        paid={payment.status === "paid"}
        locale={locale}
        t={t}
      />

      {/* The string a student is asked to quote when anything goes wrong, so it
          is copyable rather than transcribable — an unbroken 36-character UUID
          is the format people most reliably read back wrong. */}
      <footer className="space-y-2 border-t pt-6">
        <p className="text-xs text-muted-foreground">{t("buy.wise.reference")}</p>
        <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs break-all select-all">
          {payment.externalReference}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <CopyLinkButton
            value={payment.externalReference}
            label={t("web.wiseInstructions.copyReference")}
            toastMessage={t("web.wiseInstructions.referenceCopied")}
          />
          <p className="text-xs text-muted-foreground">{t("web.buyResult.referenceHint")}</p>
        </div>
      </footer>
    </main>
  );
}

type T = ReturnType<typeof getPublicFunnelT>;

type FirstClass = { startUtc: Date; timezone: string; booked: boolean };

type Tone = "success" | "info" | "warning" | "destructive";

// Every tone pairs a tinted halo with a solid disc, and both pairings are ones
// the palette contrast test already covers (`*-bg` under `*`, and
// `*-foreground` on `*`) in BOTH themes — which is why the crest is built from
// these four tokens rather than a hand-picked tint.
const CREST: Record<Tone, { halo: string; disc: string }> = {
  success: { halo: "bg-success-bg", disc: "bg-success text-success-foreground" },
  info: { halo: "bg-info-bg", disc: "bg-info text-info-foreground" },
  warning: { halo: "bg-warning-bg", disc: "bg-warning text-warning-foreground" },
  destructive: {
    halo: "bg-destructive-bg",
    disc: "bg-destructive text-destructive-foreground",
  },
};

function toneFor(status: string, isWise: boolean): Tone {
  if (status === "paid") return "success";
  if (status === "failed") return "destructive";
  if (status === "refunded") return "warning";
  // Pending. Stripe's is a few seconds of polling; Wise's waits on a human.
  return isWise ? "warning" : "info";
}

function StatusCrest({ tone }: { tone: Tone }) {
  const { halo, disc } = CREST[tone];
  const Icon = {
    success: Check,
    info: Loader2,
    warning: Clock,
    destructive: X,
  }[tone];
  return (
    <span className={`flex h-20 w-20 items-center justify-center rounded-full ${halo}`}>
      <span className={`flex h-14 w-14 items-center justify-center rounded-full ${disc}`}>
        {/* The spinner is the only honest one: `info` is the state a webhook is
            about to resolve on its own. Held behind `motion-safe` so a reader
            who asked for no motion gets a static glyph, not a moving one. */}
        <Icon
          className={`h-8 w-8 ${tone === "info" ? "motion-safe:animate-spin" : ""}`}
          strokeWidth={2.5}
          aria-hidden
        />
      </span>
    </span>
  );
}

function headerCopy(status: string, isWise: boolean, t: T): string {
  switch (status) {
    case "paid":
      return t("web.buyResult.header.paid");
    case "failed":
      return t("web.buyResult.header.failed");
    case "refunded":
      return t("buy.result.refunded");
    default:
      return isWise ? t("web.buyResult.header.waitingWise") : t("web.buyResult.header.confirming");
  }
}

// The picked slot, in the teacher's wall clock — the same zone, and now the
// same locale, the picker quoted it in at checkout. It used to format in
// "en-US" unconditionally, so a French or Spanish funnel picked a slot in its
// own language and was told about it in English one screen later.
function formatSlot(startUtc: Date, timeZone: string, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    ...timeOptionsFor(locale),
  }).format(startUtc);
}

function FirstClassCard({
  firstClass,
  locale,
  status,
  t,
}: {
  firstClass: FirstClass;
  locale: AppLocale;
  status: string;
  t: T;
}) {
  const when = formatSlot(firstClass.startUtc, firstClass.timezone, locale);
  return (
    <Card>
      <CardContent className="flex gap-4 p-5">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
            firstClass.booked ? "bg-success-bg text-success" : "bg-muted text-muted-foreground"
          }`}
        >
          <CalendarClock className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold">{t("web.buyResult.firstClassTitle")}</h2>
          {firstClass.booked ? (
            <>
              <p className="text-base font-medium">{when}</p>
              <p className="text-xs text-muted-foreground">
                {t("web.buyResult.firstClassZone", { timezone: firstClass.timezone })}
              </p>
            </>
          ) : (
            // Deliberately does NOT say the slot is held: nothing reserves it
            // until the payment lands, and on a slow rail someone else can take
            // it first (auto-book-intended then leaves the credit bookable).
            // A refunded/failed payment books nothing at all, so the promise
            // that it will be booked "as soon as the payment is confirmed" is
            // withdrawn rather than left standing.
            <p className="text-sm text-muted-foreground">
              {status === "failed" || status === "refunded"
                ? t("web.buyResult.firstClassNotBooked", { when })
                : t("web.buyResult.firstClassPending", { when })}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PurchaseSummary({
  packageName,
  classesTotal,
  classDurationMin,
  teacherName,
  teacherTimezone,
  expiresAt,
  amountMinorUnits,
  currency,
  paid,
  locale,
  t,
}: {
  packageName: string | null;
  classesTotal: number | null;
  classDurationMin: number | null;
  teacherName: string;
  teacherTimezone: string;
  expiresAt: Date | null;
  amountMinorUnits: number;
  currency: string;
  paid: boolean;
  locale: AppLocale;
  t: T;
}) {
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="space-y-1">
          {/* Sentence case, no tracking: D-140 withdrew all-caps labels,
              and a guard test (tests/config/d140-rules.test.ts) enforces it. */}
          <h2 className="text-sm font-medium text-muted-foreground">
            {t("web.buyResult.summaryTitle")}
          </h2>
          {/* The package's own name leads the card rather than sitting in a
              "Package: …" row. It is a title, not a field — and the row form
              read "Package: Package" whenever a purchase had no template, which
              is every one made from a custom price. */}
          {packageName && <p className="text-base font-semibold">{packageName}</p>}
        </div>
        <dl className="space-y-3 text-sm">
          {classesTotal !== null && classDurationMin !== null && (
            <SummaryRow
              label={t("web.buyResult.summaryClasses")}
              value={t("web.wiseInstructions.classesOf", {
                count: classesTotal,
                min: classDurationMin,
              })}
            />
          )}
          <SummaryRow label={t("web.buyResult.summaryTeacher")} value={teacherName} />
          {/* Only once the money landed. On a failed or still-pending payment
              this row would be telling her to use classes she does not have
              yet, with a deadline attached. The rest of the card describes what
              she was buying and is true either way. */}
          {paid && expiresAt && (
            <SummaryRow
              label={t("web.buyResult.summaryUseBy")}
              value={new Intl.DateTimeFormat(locale, {
                timeZone: teacherTimezone,
                day: "numeric",
                month: "long",
                year: "numeric",
              }).format(expiresAt)}
            />
          )}
          {/* The total sits last and heavier — the one number she came back to
              this page to check, and the reason the paid-state sentence above
              no longer repeats it mid-prose. */}
          <div className="flex items-baseline justify-between gap-4 border-t pt-3">
            <dt className="text-muted-foreground">
              {paid ? t("web.buyResult.summaryPaid") : t("web.buyResult.summaryAmount")}
            </dt>
            <dd className="text-base font-semibold">
              {formatMinorUnits(amountMinorUnits, currency)}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{value}</dd>
    </div>
  );
}

// Actions sit side by side from `sm` up and stack full-width below it, so the
// primary is never a half-width target on a phone. They used to be two
// inline-flex siblings inside a prose block, which put them on one line at
// whatever width their labels happened to be.
function Actions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row [&>*]:w-full sm:[&>*]:flex-1">{children}</div>
  );
}

function StatusBody({
  status,
  isWise,
  slug,
  studentEmail,
  paymentReference,
  selfSignedIn,
  firstClass,
  classesTotal,
  t,
}: {
  status: string;
  isWise: boolean;
  slug: string;
  studentEmail: string | null;
  paymentReference: string | null;
  selfSignedIn: boolean;
  firstClass: FirstClass | null;
  classesTotal: number | null;
  t: T;
}) {
  if (status === "paid" && selfSignedIn) {
    // Buying a multi-class package creates NO booking on its own — only
    // credits — so "your package is active" is followed by an empty schedule
    // until she books. A picked first class fills exactly one of those slots,
    // never the rest, which is why the primary action flips once it lands:
    // "book your first class" is wrong copy for someone whose first class is
    // already on the calendar, and for a single class it is a dead end.
    const alreadyBooked = firstClass?.booked === true;
    const hasClassesLeft = classesTotal === null || classesTotal > (alreadyBooked ? 1 : 0);
    return (
      <div className="space-y-5">
        <p className="text-center">{t("web.buyResult.paidSelfSignedIn")}</p>
        <Actions>
          {alreadyBooked ? (
            <>
              <Button asChild>
                <Link href="/my-classes">{t("book.confirm.viewMine")}</Link>
              </Button>
              {hasClassesLeft && (
                <Button asChild variant="outline">
                  <Link href="/my-classes/book">{t("book.confirm.bookAnother")}</Link>
                </Button>
              )}
            </>
          ) : (
            <>
              <Button asChild>
                <Link href="/my-classes/book">{t("web.buyResult.bookFirstClass")}</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/my-classes">{t("book.confirm.viewMine")}</Link>
              </Button>
            </>
          )}
        </Actions>
      </div>
    );
  }
  if (status === "paid") {
    return (
      <div className="space-y-5">
        <p className="text-center">
          {studentEmail
            ? t("web.buyResult.paidWithEmail", { email: studentEmail })
            : t("web.buyResult.paidNoEmail")}
        </p>
        {/* Says what happens AFTER she signs in. Deliberately NOT a link to
            /my-classes/book: with no session yet, middleware bounces every
            student path to `/`, so a button here would be a dead end. The
            emailed link is the only way in — this just stops "your package is
            active" reading as if a class were already scheduled. When she DID
            pick a first class and it landed, the default copy would be the
            wrong way round (one is scheduled), so the follow-up points at the
            rest instead. */}
        <p className="text-center text-sm text-muted-foreground">
          {firstClass?.booked
            ? t("web.buyResult.nextStepAfterFirstClass")
            : t("web.buyResult.nextStepBook")}
        </p>
        {studentEmail && (
          <div className="flex flex-col items-center gap-3 rounded-md border bg-muted/40 p-4">
            <p className="text-center text-sm text-muted-foreground">
              {t("web.buyResult.resendHint")}
            </p>
            <ResendSignInLink email={studentEmail} />
          </div>
        )}
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="space-y-5">
        <p className="text-center">{t("web.buyResult.failedBody")}</p>
        <Actions>
          <Button asChild>
            <Link href={`/b/${slug}/buy`}>{t("web.buyResult.backToPackages")}</Link>
          </Button>
        </Actions>
      </div>
    );
  }
  if (status === "refunded") {
    return <p className="text-center">{t("web.buyResult.refundedBody")}</p>;
  }
  if (isWise) {
    return (
      <div className="space-y-5">
        <p className="text-center">{t("web.buyResult.wisePendingBody")}</p>
        {paymentReference && (
          <Actions>
            <Button asChild variant="outline">
              <Link href={`/b/${slug}/buy/transfer/${paymentReference}`}>
                {t("web.buyResult.viewTransferInstructions")}
              </Link>
            </Button>
          </Actions>
        )}
      </div>
    );
  }
  return <p className="text-center">{t("web.buyResult.stripePendingBody")}</p>;
}
