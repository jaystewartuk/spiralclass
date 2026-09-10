import type { Metadata } from "next";
import Link from "next/link";
import { growthSteps, resolveDashboardTiles, type DashboardTilePref } from "@spiralclass/shared";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import type { CashFlowSummary } from "@/lib/cashflow";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getPreferredLocale, getT } from "@/lib/i18n";

/**
 * The public demo (D-142).
 *
 * WHY THIS EXISTS. The teacher dashboard is the part of this product worth
 * showing and the part nobody can see, because it sits behind an email-OTP
 * wall. A stranger evaluating the work had, until now, only screenshots.
 *
 * WHY IT IS NOT A DEMO ACCOUNT. The obvious version — seed a teacher, publish
 * the credentials — needs a way to sign in without proving identity, which is
 * a new authentication surface on a system holding live payment records. And
 * "read-only" would have to be enforced across 68 server-action files with no
 * write chokepoint to put it in; one miss and a stranger mutates production.
 * The risk is entirely on the wrong side of the trade for a portfolio feature.
 *
 * WHAT THIS DOES INSTEAD. It renders the real <DashboardView> — the same
 * component /dashboard renders, not a copy — from a fixture built here. There
 * is no session, so there is nothing to authenticate; there are no actions
 * wired, so there is nothing to mutate; and no query runs, so no real row is
 * reachable even in principle. The demo cannot be wrong about the dashboard's
 * appearance, because it IS the dashboard, and it cannot touch anything,
 * because the capability is absent rather than merely disabled.
 *
 * THE HONEST LIMITATION, stated because the page states it too: this is one
 * screen with invented numbers. It is not a walkthrough of the product.
 */

// One currency, like every real teacher: cash flow is reported per currency
// (see lib/cashflow.ts) and the demo has nothing to say about the teacher who
// changed hers mid-flight.
const DEMO_CASH_FLOW: CashFlowSummary = {
  currency: "MXN",
  totalPaidCents: 4_860_00,
  earnedCents: 3_920_00,
  heldCents: 940_00,
  heldLessons: 11,
  safeMonthlySpendCents: 1_240_00,
  provisionalMonths: 0,
  currentMonthEarnedCents: 1_380_00,
  currentMonthLessons: 17,
};

export const metadata: Metadata = {
  title: "Demo — the teacher dashboard",
  description:
    "The SpiralClass teacher dashboard, rendered from the real component with fictional data. No account required.",
  // Deliberately not indexed. The figures are invented and the teacher does
  // not exist, so a prospective student who found this in a search result
  // would be reading fiction about a real product.
  robots: { index: false, follow: true },
};

/**
 * The demo's clock, pinned.
 *
 * The schedule card renders "Today", "Tomorrow" and wall-clock times on the
 * SERVER, so `page.clock.setFixedTime` in tests/visual/regression.spec.ts —
 * which only reaches the browser — cannot hold them still. A live `new Date()`
 * here would make this page's committed visual baseline fail every night at
 * midnight, for no reason anyone could act on. It is the same instant the
 * regression spec pins, so the two agree about what "today" is.
 *
 * Pinning it costs nothing that matters: every figure on this page is already
 * invented, and the banner says so.
 */
const DEMO_NOW = new Date("2026-09-01T15:00:00.000Z");

/** `DEMO_NOW` plus `hours`, for a fixture class time that reads naturally. */
function demoTime(hours: number): Date {
  return new Date(DEMO_NOW.getTime() + hours * 60 * 60 * 1000);
}

export default async function DemoPage() {
  const locale = await getPreferredLocale();
  const t = await getT();

  // A teacher far enough along to be interesting: publicly listed, paid,
  // with real activity — so the screen shows the steady state rather than
  // the empty state. Every figure below is invented.
  const growth = growthSteps(
    {
      hasPayoutMethod: true,
      hasPhoto: true,
      hasBio: true,
      testimonialCount: 6,
      hasStudents: true,
      newLeadCount: 3,
      stripeAvailable: true,
    },
    locale,
  );

  const tiles = resolveDashboardTiles(null as DashboardTilePref[] | null);

  return (
    <>
      {/* The same column PageShell width="wide" puts the dashboard in — the
          banner was centred on the VIEWPORT while the screen under it was
          centred in the content container, so the two disagreed by a visible
          margin at every width above the container's cap. */}
      <div className="lg:max-w-content container pt-8">
        <Alert variant="info">
          <AlertTitle>{t("web.demo.banner.title")}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{t("web.demo.banner.body")}</p>
            <p>
              <Link href="/design" className="underline underline-offset-2">
                {t("web.demo.banner.designLink")}
              </Link>{" "}
              {t("web.demo.banner.designNote")}
            </p>
          </AlertDescription>
        </Alert>
      </div>

      <DashboardView
        readOnly
        teacherName="Valentina"
        timezone="America/Mexico_City"
        bookingSlug="valentina-rios"
        bookingUrl="https://spiralclass.com/b/valentina-rios"
        locale={locale}
        now={DEMO_NOW}
        schedule={{
          // Two of them in a different zone from hers, so the page shows the
          // dual-clock line the product exists to get right rather than hiding
          // its most distinctive behaviour behind a same-zone fixture.
          upcoming: [
            {
              id: "demo-1",
              scheduledStart: demoTime(3),
              studentName: "Mariana Duarte",
              studentTimezone: "America/Mexico_City",
              packageName: "Conversación",
              durationMin: 50,
            },
            {
              id: "demo-2",
              scheduledStart: demoTime(5),
              studentName: "Tom Whitfield",
              studentTimezone: "Europe/London",
              packageName: "Business Spanish",
              durationMin: 50,
            },
            {
              id: "demo-3",
              scheduledStart: demoTime(23),
              studentName: "Kenji Aoki",
              studentTimezone: "Asia/Tokyo",
              packageName: "Conversación",
              durationMin: 25,
            },
            {
              id: "demo-4",
              scheduledStart: demoTime(27),
              studentName: "Sofía Restrepo",
              studentTimezone: "America/Mexico_City",
              packageName: "Intensivo",
              durationMin: 80,
            },
          ],
          weekAhead: 9,
        }}
        hasNoActivityYet={false}
        marketplaceReady
        missingSignals={[]}
        stripeConnected
        transferConnected={false}
        stripeAvailable
        growth={growth}
        cashFlow={{ primary: DEMO_CASH_FLOW, byCurrency: [DEMO_CASH_FLOW] }}
        visibleTileKeys={tiles.filter((tile) => !tile.hidden).map((tile) => tile.key)}
        newLeadCount={3}
      />
    </>
  );
}
