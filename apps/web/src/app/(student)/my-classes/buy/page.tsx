import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { prisma } from "@/lib/prisma";
import { requireStudent } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { studentIdentityIds } from "@/lib/students/identity";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PortalPurchaseFlow } from "./portal-purchase-flow";
import { currencyForTeacher } from "@spiralclass/shared";
import { INSTRUMENT_SELECT, offerableInstruments } from "@/lib/payments/instruments";
import { grandfatheredPricesFor } from "@/lib/payments/grandfathered-prices";

// In-portal repurchase. The public /b/[slug]/buy page stays the
// anonymous acquisition funnel; this page is the signed-in path for the
// student who already has a relationship with a teacher and just needs
// another package — no name/email/phone re-entry, no duplicate-account
// risk, grandfathered pricing shown up front.
//
// Design note (multi-teacher): packages are per-teacher, and a student can
// in principle be linked to several teachers. The page is therefore scoped
// by teacher — `?maestra=<teacherId>` selects which roster to buy from, a
// picker renders when there's more than one, and the single-teacher alpha
// resolves to the only link without any UI. Keep the teacherId in the route
// state (not inferred globally) so this generalizes without a rework.

export const dynamic = "force-dynamic";

export default async function PortalComprarPage({
  searchParams,
}: {
  searchParams: Promise<{ maestra?: string }>;
}) {
  const student = await requireStudent();
  const params = await searchParams;
  const t = await getT();

  // Active pairings only: archived ("dar de baja") links don't get their
  // teacher's packages offered back proactively, and a teacher who never
  // finished onboarding (or was disabled by moderation) can't sell.
  // Spans the whole identity (see studentIdentityIds) so a sibling row's
  // teacher shows up in the picker too.
  const identityIds = await studentIdentityIds(student);
  const links = await prisma.teacherStudent.findMany({
    where: {
      studentId: { in: identityIds },
      archivedAt: null,
      teacher: { onboardingCompleteAt: { not: null }, disabledAt: null },
    },
    orderBy: { createdAt: "asc" },
    select: {
      // The pairing row itself, not just the teacher: it is the row checkout
      // will charge through (purchasingLinkFor picks the same one — oldest,
      // non-archived), and therefore the only row whose agreed prices may be
      // shown here. See lib/students/identity.ts.
      studentId: true,
      teacher: {
        select: {
          id: true,
          name: true,
          stripeAccountId: true,
          stripeChargesEnabled: true,
          pricingCurrency: true,
          payoutInstruments: { select: INSTRUMENT_SELECT },
          packageTemplates: {
            where: { archived: false },
            orderBy: { priceMinorUnits: "asc" },
            select: {
              id: true,
              name: true,
              classCount: true,
              classDurationMin: true,
              priceMinorUnits: true,
              transferPriceMinorUnits: true,
              expirationMonths: true,
            },
          },
        },
      },
    },
  });

  // One pairing per teacher, the oldest — the same row `purchasingLinkFor`
  // resolves and checkout therefore charges through. A second pairing with the
  // same teacher on a sibling student row is possible ("one row per (teacher,
  // email)" is an app invariant, not a DB constraint); leaving it in listed the
  // teacher twice in the picker below, under a duplicate React key, and offered
  // her through a row no purchase can reach. `links` is ordered createdAt asc,
  // so first-wins is oldest-wins.
  const byTeacher = new Map<string, (typeof links)[number]>();
  for (const l of links) if (!byTeacher.has(l.teacher.id)) byTeacher.set(l.teacher.id, l);
  const pairings = [...byTeacher.values()];

  const selected = pairings.find((l) => l.teacher.id === params.maestra) ?? pairings[0] ?? null;

  if (!selected) {
    return (
      <PageShell width="reading">
        <BackLink t={t} />
        <Card>
          <CardHeader>
            <CardTitle>{t("buyAnother.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              {t("buyAnother.none")}. {t("buyAnother.noneHint")}
            </p>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  const teacher = selected.teacher;
  // Grandfathering, per package — resolved against the pairing row this
  // purchase will actually be charged through, NOT across the identity set.
  // What is displayed here and what startCheckout charges must come from the
  // same student row or the page lies about the price; see purchasingLinkFor.
  const agreedPrices = Object.fromEntries(
    await grandfatheredPricesFor(prisma, teacher.id, selected.studentId),
  );
  const stripeReady = Boolean(teacher.stripeAccountId && teacher.stripeChargesEnabled);
  // Offerable instruments only — see lib/payments/instruments.ts. Filtered
  // server-side so the credential columns never reach the client bundle.
  const instruments = offerableInstruments(teacher.payoutInstruments, currencyForTeacher(teacher));
  const noMethods = !stripeReady && instruments.length === 0;

  return (
    <PageShell width="reading">
      <BackLink t={t} />

      <header>
        <PageHeader title={t("buyAnother.title")} />
        <p className="text-muted-foreground text-sm">
          {t("buyAnother.with", { name: teacher.name })}
        </p>
      </header>

      {pairings.length > 1 && (
        <div>
          <p className="mb-2 text-sm font-medium">{t("buyAnother.teacher")}</p>
          <div className="flex flex-wrap gap-2">
            {pairings.map((l) => (
              <Link
                key={l.teacher.id}
                href={`/my-classes/buy?maestra=${l.teacher.id}`}
                className={`rounded-md border px-3 py-1 text-sm ${
                  l.teacher.id === teacher.id ? "border-primary bg-primary/10" : ""
                }`}
              >
                {l.teacher.name}
              </Link>
            ))}
          </div>
        </div>
      )}

      {noMethods && (
        <div className="border-warning/30 bg-warning-bg text-warning rounded-md border px-4 py-3 text-sm">
          {t("buyAnother.noMethods")}
        </div>
      )}

      {teacher.packageTemplates.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("buyAnother.noPackages")}</p>
      ) : (
        <PortalPurchaseFlow
          teacherId={teacher.id}
          templates={teacher.packageTemplates}
          agreedPrices={agreedPrices}
          stripeReady={stripeReady}
          instruments={instruments}
        />
      )}

      {/* The seller-of-record (CFDI) disclaimer now renders inside
          PortalPurchaseFlow, rail-aware — it needs the selected payment
          method, which only exists inside that client component. */}
      <footer className="text-muted-foreground space-y-2 border-t pt-4 text-xs">
        <p>
          {t("book.byPaying")}{" "}
          <Link href="/privacy-notice" className="underline">
            {t("web.signUp.privacyNotice")}
          </Link>
          .
        </p>
      </footer>
    </PageShell>
  );
}

function BackLink({ t }: { t: Awaited<ReturnType<typeof getT>> }) {
  return (
    <div>
      <Link href="/my-classes" className="text-sm underline">
        {t("web.studentBuy.backToClasses")}
      </Link>
    </div>
  );
}
