import { requireOnboardedTeacher } from "@/lib/auth";
import { hasStripeCreds, serverEnv } from "@/lib/env";
import { getPreferredLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { currencyForTeacher, hasOfferableInstrument } from "@spiralclass/shared";
import { INSTRUMENT_READINESS_SELECT } from "@/lib/marketplace-ready";
import { computeTeacherCashFlow } from "@/lib/cashflow";
import {
  growthSteps,
  isConnectCountrySupported,
  isMarketplaceReady,
  missingMarketplaceSignals,
  resolveDashboardTiles,
  type DashboardTilePref,
} from "@spiralclass/shared";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { DashboardView } from "@/components/dashboard/dashboard-view";

/**
 * How many upcoming classes the schedule card lists. Enough to answer "what is
 * the rest of today, and roughly what is tomorrow"; the full roster is one
 * click away on /dashboard/classes, which is what the card's footer links to.
 */
const UPCOMING_CLASS_LIMIT = 5;

/**
 * The teacher's dashboard.
 *
 * This page is the DATA half only; every layout and copy decision lives in
 * <DashboardView>, which /demo renders from a fixture (D-142). The division is
 * not cosmetic — it is what keeps the public demo from drifting away from the
 * real screen. Anything with an effect (the dashboard_viewed event below, the
 * cash-flow query) belongs on this side of the line, which is why the demo
 * cannot emit a real teacher's telemetry even by accident.
 */
export default async function DashboardPage() {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const appUrl = serverEnv().APP_URL.replace(/\/$/, "");
  const bookingUrl = `${appUrl}/b/${teacher.bookingSlug}`;
  const stripeConnected = Boolean(teacher.stripeAccountId && teacher.stripeChargesEnabled);
  // Any offerable payout instrument counts, not Wise specifically (D-113) —
  // a teacher whose only rail is SPEI is just as payable.
  const transferConnected = hasOfferableInstrument(
    await prisma.teacherPayoutInstrument.findMany({
      where: { teacherId: teacher.id },
      select: INSTRUMENT_READINESS_SELECT,
    }),
    currencyForTeacher(teacher),
  );
  const hasPayoutMethod = stripeConnected || transferConnected;
  // Same gate settings/payments/page.tsx uses: only mention Stripe in the
  // payments-card/growth-checklist copy where the platform can actually pay
  // the teacher out (SUPPORTED_CONNECT_COUNTRIES) — or where a legacy account
  // is already linked. Everyone else sees Wise-only copy, matching what the
  // settings page itself would show her.
  const payoutCountrySupported = isConnectCountrySupported(teacher.country);
  const isLinked = Boolean(teacher.stripeAccountId);
  const stripeAvailable = hasStripeCreds() && (payoutCountrySupported || isLinked);

  // Brand-new teacher: no students linked, no bookings booked. Distinct from
  // `marketplaceReady` below — this is about ACTIVITY (has she ever had a
  // student?), not READINESS (can she structurally get paid + is her profile
  // real?). Kept separate on purpose: a
  // teacher with real students/bookings should still see the "Book on behalf"
  // CTA and her cash-flow tile regardless of payment-rail status.
  // All three counts are independent, indexed-by-teacher_id reads — batch them
  // into one round-trip. New (unworked) leads drive a count badge on the "Leads"
  // tile; the published-testimonial count feeds the "Crecer" growth checklist;
  // the teacher `_count` decides the no-activity-yet branches below.
  // The screen leads on her schedule now, so the soonest scheduled classes and
  // the week's total join the same round-trip. Both ride the (teacher_id,
  // status, scheduled_start) access path the classes page already uses, and
  // both are bounded — five rows and a count, never a scan of her history.
  const now = new Date();
  const weekEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const [counts, newLeadCount, testimonialCount, upcoming, weekAhead] = await Promise.all([
    prisma.teacher.findUnique({
      where: { id: teacher.id },
      select: {
        _count: { select: { teacherStudents: true, bookings: true } },
      },
    }),
    prisma.lead.count({ where: { teacherId: teacher.id, status: "new" } }),
    prisma.testimonial.count({ where: { teacherId: teacher.id, published: true } }),
    prisma.booking.findMany({
      where: { teacherId: teacher.id, status: "scheduled", scheduledStart: { gte: now } },
      orderBy: { scheduledStart: "asc" },
      take: UPCOMING_CLASS_LIMIT,
      select: {
        id: true,
        scheduledStart: true,
        student: { select: { name: true, timezone: true } },
        package: {
          select: { classDurationMin: true, template: { select: { name: true } } },
        },
      },
    }),
    prisma.booking.count({
      where: {
        teacherId: teacher.id,
        status: "scheduled",
        scheduledStart: { gte: now, lt: weekEnd },
      },
    }),
  ]);
  const hasNoActivityYet = counts?._count.teacherStudents === 0 && counts?._count.bookings === 0;

  // `onboardingCompleteAt` alone only ever
  // meant "submitted the 4-step wizard" — this is the real "ready for the
  // marketplace" signal (real profile + reviewed offer/schedule + a connected
  // payout rail), and the gate the public-listing checks on /b/[slug] use.
  const marketplaceSignals = {
    onboardingComplete: Boolean(teacher.onboardingCompleteAt),
    hasPhoto: Boolean(teacher.photoPath),
    hasBio: Boolean(teacher.bio),
    templatesTouched: Boolean(teacher.templatesTouchedAt),
    availabilityTouched: Boolean(teacher.availabilityTouchedAt),
    hasPayoutMethod,
  };
  const marketplaceReady = isMarketplaceReady(marketplaceSignals);
  // Which signals are actually unmet, so the warning below can name them
  // instead of pointing at the growth checklist — which has no signal for
  // templatesTouched/availabilityTouched and so renders all-done for a teacher
  // de-listed by exactly those two. See missingMarketplaceSignals().
  const missingSignals = missingMarketplaceSignals(marketplaceSignals);

  // The in-app teacher-amplification guide (D-24): an ROI-ordered checklist of
  // the shipped acquisition features, with each step's done-state derived from
  // real data so it reads as live progress, not a stale help article. Leads
  // with the payment-rail step since nothing else here matters
  // until a teacher can actually get paid.
  const growth = growthSteps(
    {
      hasPayoutMethod,
      hasPhoto: Boolean(teacher.photoPath),
      hasBio: Boolean(teacher.bio),
      testimonialCount,
      hasStudents: (counts?._count.teacherStudents ?? 0) > 0,
      newLeadCount,
      stripeAvailable,
    },
    locale,
  );

  // Cash-flow summary — skipped while there's no activity yet (nothing to
  // split); unrelated to marketplaceReady, which is about payability, not volume.
  const cashFlow = hasNoActivityYet ? null : await computeTeacherCashFlow(teacher.id);

  // Denominator for every activation/checklist-engagement funnel (previously
  // absent on both platforms).
  trackServerEvent({
    name: "dashboard_viewed",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, surface: "web" },
  });

  // Teacher-customizable order/visibility for the "Day to day" grid below —
  // see resolveDashboardTiles() for the merge-with-defaults behaviour.
  const tiles = resolveDashboardTiles(teacher.dashboardTileOrder as DashboardTilePref[] | null);
  const visibleTileKeys = tiles.filter((t) => !t.hidden).map((t) => t.key);

  return (
    <DashboardView
      teacherName={teacher.name}
      timezone={teacher.timezone}
      bookingSlug={teacher.bookingSlug}
      bookingUrl={bookingUrl}
      locale={locale}
      now={now}
      schedule={{
        upcoming: upcoming.map((booking) => ({
          id: booking.id,
          scheduledStart: booking.scheduledStart,
          studentName: booking.student.name,
          studentTimezone: booking.student.timezone,
          packageName: booking.package?.template?.name ?? null,
          durationMin: booking.package?.classDurationMin ?? null,
        })),
        weekAhead,
      }}
      hasNoActivityYet={hasNoActivityYet}
      marketplaceReady={marketplaceReady}
      missingSignals={missingSignals}
      stripeConnected={stripeConnected}
      transferConnected={transferConnected}
      stripeAvailable={stripeAvailable}
      growth={growth}
      cashFlow={cashFlow}
      visibleTileKeys={visibleTileKeys}
      newLeadCount={newLeadCount}
    />
  );
}
