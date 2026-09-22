// Teacher activation model (the teacher-activation review
// activation audit). `Teacher.onboardingCompleteAt` alone only ever meant "submitted the
// 4/5-step wizard" — it says nothing about whether a teacher has a real
// photo/bio, a customized offer, a reviewed schedule, or a way to actually get
// paid. This module is the single, platform-agnostic resolver for the richer
// activation states derived from those signals, so web, mobile, and admin
// can never disagree about what "ready for the marketplace" means — the same
// pattern `growthSteps()` already established for the "Crecer" checklist.
//
// Pure functions only: every state here is computed on read from data that
// already exists (or the two `*TouchedAt` timestamps added alongside this
// module), matching this codebase's existing preference for derived state
// (isNewTeacher, isWiseReady, growthSteps) over a stored status enum.

// The signal subset isMarketplaceReady() needs — deliberately its own type
// (not a slice of ActivationSignals below) so every call site that only
// cares about public-listing readiness (the gate itself, the dashboard
// banner, the admin "stalled" filter) can build just these six booleans
// without also sourcing booking/payment counts it doesn't need.
export type MarketplaceReadinessSignals = {
  onboardingComplete: boolean;
  hasPhoto: boolean;
  hasBio: boolean;
  templatesTouched: boolean;
  availabilityTouched: boolean;
  hasPayoutMethod: boolean;
};

// The full signal set needed to resolve every named activation state
// (superset of MarketplaceReadinessSignals). Each app maps its own data
// source onto this shape:
//   - web: reads the Teacher row directly (Prisma).
//   - mobile: reads the same fields off the /api/mobile/teacher/dashboard
//     response, which the server populates from the same Teacher row.
export type ActivationSignals = MarketplaceReadinessSignals & {
  bookingCount: number;
  hasReceivedPayment: boolean;
  // Bookings in the trailing 30 days, for the rolling "Active Teacher" state.
  // Optional because not every call site (e.g. the public-listing gate) needs
  // it — omit it and `activeTeacher` simply resolves to false.
  bookingsLast30Days?: number;
};

export type ActivationState = {
  // "Baseline Configured" — today's onboardingCompleteAt gate, renamed to
  // make clear it's the first rung, not the finish line.
  baselineConfigured: boolean;
  profileComplete: boolean;
  teachingOfferCustomized: boolean;
  availabilityReviewed: boolean;
  paymentConnected: boolean;
  // The proposed new public-listing gate: baseline configured AND every
  // sub-state below it. See isMarketplaceReady() below — kept in lock-step
  // with this field so the two can never drift.
  marketplaceReady: boolean;
  firstBookingReceived: boolean;
  firstPaymentReceived: boolean;
  activeTeacher: boolean;
};

/**
 * Baseline pass/fail for the *public-listing* gate. This is intentionally the
 * one state in the model that changes product behavior (see the audit
 * design principles) — every other resolved state is informational only.
 */
export function isMarketplaceReady(signals: MarketplaceReadinessSignals): boolean {
  return (
    signals.onboardingComplete &&
    signals.hasPhoto &&
    signals.hasBio &&
    signals.templatesTouched &&
    signals.availabilityTouched &&
    signals.hasPayoutMethod
  );
}

/** The six signals isMarketplaceReady() checks, as addressable keys. */
export type MarketplaceSignalKey = keyof MarketplaceReadinessSignals;

// Evaluation order = the order a teacher should fix them in: get into the
// product, then look real, then have something to sell at a bookable time,
// then be payable. Kept as an explicit list (not Object.keys) so the order is
// deliberate and stable rather than an accident of object literal order.
const MARKETPLACE_SIGNAL_ORDER: readonly MarketplaceSignalKey[] = [
  "onboardingComplete",
  "hasPhoto",
  "hasBio",
  "templatesTouched",
  "availabilityTouched",
  "hasPayoutMethod",
] as const;

/**
 * Which of the public-listing signals are still unmet, in the order a teacher
 * should address them. Empty exactly when isMarketplaceReady() is true.
 *
 * Exists because "not ready" on its own is unactionable. The dashboard's
 * not-public warning used to point at the "Crecer" growth checklist for the
 * remedy, but that checklist's signals (`GrowthSignals` in growth.ts) cover
 * only photo/bio/payout/testimonials/students/leads — it has no notion of
 * `templatesTouched` or `availabilityTouched`. A teacher missing *only* those
 * two therefore saw a warning telling her to finish a checklist on which
 * every step was already ticked, with nothing anywhere naming the real cause.
 * That is not hypothetical: it is how the 2026-07-26 de-listing (see the
 * regression case in apps/web/tests/seo/sitemap.test.ts) stayed invisible
 * from inside the product. Callers render one line per key, each linking to
 * the surface that fixes it.
 */
export function missingMarketplaceSignals(
  signals: MarketplaceReadinessSignals,
): MarketplaceSignalKey[] {
  return MARKETPLACE_SIGNAL_ORDER.filter((key) => !signals[key]);
}

/**
 * Resolve every named activation state for a teacher. Pure and side-effect
 * free — feed it signals, render/gate on the result.
 */
export function resolveActivationState(signals: ActivationSignals): ActivationState {
  const profileComplete = signals.hasPhoto && signals.hasBio;
  const marketplaceReady = isMarketplaceReady(signals);
  return {
    baselineConfigured: signals.onboardingComplete,
    profileComplete,
    teachingOfferCustomized: signals.templatesTouched,
    availabilityReviewed: signals.availabilityTouched,
    paymentConnected: signals.hasPayoutMethod,
    marketplaceReady,
    firstBookingReceived: signals.bookingCount >= 1,
    firstPaymentReceived: signals.hasReceivedPayment,
    activeTeacher: (signals.bookingsLast30Days ?? 0) >= 1,
  };
}
