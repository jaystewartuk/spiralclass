// SpiralClass — subscription / monetization config.
//
// THE single source of truth for every plan price, cap, window, and rate the
// monetization feature depends on. The task brief is explicit: "Surface all
// numbers (prices, trial length, grace, caps, founding cutoff/cap, commission
// rate/window) as named constants in ONE config module — no scattered
// literals." Anything that reads a price, a cap, or a window MUST import it
// from here.
//
// Money is in integer minor units; the CANONICAL billing currency is GBP
// (PLATFORM_MONEY_CURRENCY, ./platform-regions.ts) — the platform's own UK
// UK Stripe entity (D-58/D-99). It was MXN before D-99: a
// per-currency price table (below) is what lets that change without
// reinterpreting any pre-existing MXN subscriber's already-stored
// `lockedPriceMinorUnits`/`currency` (see billing-webhook-handler.ts — a live
// subscriber's actual billing currency always comes from their own Stripe
// object, never re-derived from this table after activation). Shared so web
// and mobile resolve plan prices/caps/windows and entitlements from the same
// source. See docs/features/subscriptions.md for the product rationale.

// --- Plans -----------------------------------------------------------------

// The four billable plan identifiers persisted on teacher_subscriptions.plan.
// `free` is the permanent no-cost tier; the three paid variants all unlock the
// full Pro entitlement set (see entitlements.ts). Snake_case-free single words
// to match the existing enum value style (e.g. PaymentProvider.stripe).
export const SUBSCRIPTION_PLANS = ["free", "monthly", "annual", "founding"] as const;
export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];

// Lifecycle states persisted on teacher_subscriptions.status. `comped` is NOT
// a status — it's a separate boolean flag (a comped teacher can be `active`
// with comped=true) so the billing status and the "never charge" decision stay
// orthogonal.
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "free",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

// --- Prices (integer minor units, per currency) ----------------------------

// Plan prices keyed by settlement currency. GBP is the canonical/new-checkout
// currency as of D-99 (PLATFORM_MONEY_CURRENCY); MXN is kept as the pre-D-99
// launch pricing — still resolvable by currency so an existing MXN
// subscriber's grandfathered/renewal price keeps computing correctly (see
// foundingLockedPrice in billing-webhook-handler.ts) — but no new checkout
// prices into it. Amounts are integer minor units in that currency (pence for
// GBP, centavos for MXN — the generic term is minor units).
export const PLAN_PRICE_MINOR_UNITS_BY_CURRENCY: Record<
  string,
  Record<SubscriptionPlan, number>
> = {
  GBP: {
    free: 0,
    // £7.99 / month.
    monthly: 799,
    // £79.90 / year — exactly 10x monthly, ~2 months free (same ratio as the
    // original MXN pricing).
    annual: 7_990,
    // Founding: £5.99 / month, price-locked for the life of the subscription.
    founding: 599,
  },
  // Pre-D-99 (Mexican-launch-era) pricing. Frozen — never updated — so a
  // grandfathered MXN subscriber's renewal/upgrade math stays stable. New
  // checkouts always resolve through the GBP table (see
  // start-billing-checkout.ts's fixed Stripe Price ids, one per plan, all
  // configured against the GBP Prices in the UK Stripe account).
  MXN: {
    free: 0,
    // 199 MXN / month — the sweet spot from the original brief.
    monthly: 19_900,
    // 1,990 MXN / year (~166/mo, ~2 months free).
    annual: 199_000,
    // Founding: 149 MXN / month, price-locked for the life of the subscription.
    founding: 14_900,
  },
};

// Back-compat default table (GBP, the canonical currency as of D-99). Prefer
// planPriceMinorUnits(plan, currency) so a specific-currency reader (e.g. an
// existing MXN subscriber's own row) resolves correctly; this alias is for
// callers that only ever want "the current canonical price" (the pricing
// page, new-checkout estimates).
export const PLAN_PRICE_MINOR_UNITS: Record<SubscriptionPlan, number> =
  PLAN_PRICE_MINOR_UNITS_BY_CURRENCY.GBP;

// The price of a plan in a given settlement currency. Unknown currency falls
// back to the canonical GBP table — never undefined.
export function planPriceMinorUnits(plan: SubscriptionPlan, currency: string = "GBP"): number {
  const table =
    PLAN_PRICE_MINOR_UNITS_BY_CURRENCY[currency.toUpperCase()] ??
    PLAN_PRICE_MINOR_UNITS_BY_CURRENCY.GBP;
  return table[plan];
}

// Billing interval per plan — drives MRR normalization in the admin overview.
export const PLAN_INTERVAL: Record<SubscriptionPlan, "month" | "year" | "none"> = {
  free: "none",
  monthly: "month",
  annual: "year",
  founding: "month",
};

// --- Trial / grace ---------------------------------------------------------

// New teachers (and existing teachers at deploy) get a 30-day Pro trial with
// no card required, then fall to Free — never locked out.
export const TRIAL_DAYS = 30;

// When a charge fails the teacher enters `past_due` and keeps full Pro for a
// 7-day grace window (with a persistent "update payment" banner) before
// dropping to Free.
export const PAST_DUE_GRACE_DAYS = 7;

// How many days before trial end we send the "trial ending" nudge.
export const TRIAL_ENDING_NOTICE_DAYS = 3;

// --- Free-tier caps --------------------------------------------------------

// A Free teacher can have at most this many ACTIVE students on their roster.
// Over-cap data is grandfathered read-only on downgrade — never deleted (see
// entitlements.ts + the enforcement points).
export const FREE_MAX_ACTIVE_STUDENTS = 3;

// A Free teacher can have at most this many non-archived package templates.
export const FREE_MAX_PACKAGE_TEMPLATES = 1;

// --- Founding cohort -------------------------------------------------------

// The founding price is offered only while the cohort is open: it
// closes when EITHER the headcount cap is reached OR the cutoff date passes
// (whichever comes first). Defaults: first 50 teachers / 90 days from launch.
export const FOUNDING_MAX_TEACHERS = 50;
export const FOUNDING_WINDOW_DAYS = 90;

// Platform launch date (UTC). The founding cutoff is launch + FOUNDING_WINDOW_DAYS.
// 2026-05-27 was the documented launch (see CLAUDE.md).
export const LAUNCH_DATE = new Date("2026-05-27T00:00:00.000Z");

export function foundingCutoffDate(launch: Date = LAUNCH_DATE): Date {
  return new Date(launch.getTime() + FOUNDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

// True while the founding cohort is still open given the current headcount and
// clock. Headcount is the count of teachers already on a founding subscription
// (the founding_cohort source-of-truth row tracks this; callers pass it in).
export function isFoundingCohortOpen(input: {
  foundingHeadcount: number;
  now?: Date;
  launch?: Date;
}): boolean {
  const now = input.now ?? new Date();
  const cutoff = foundingCutoffDate(input.launch ?? LAUNCH_DATE);
  return input.foundingHeadcount < FOUNDING_MAX_TEACHERS && now < cutoff;
}

// --- Ambassador commission (referral attribution) --------------------------
//
// An ambassador referral is platform-funded and paid out of band (see the
// referrals design for why the full referral engine is deferred). The only
// computable piece is a share of the NET of each paid subscription invoice
// inside a window that starts at the referred account's creation.
//
// The RATE is not here. It is the term of a private arrangement with a
// specific person and this repository is public, so it is deployment
// configuration -- commissionRate() in
// apps/web/src/lib/subscriptions/commission.ts, from COMMISSION_RATE_PERCENT.
// Unset means a zero payable and a report that visibly says so, rather than a
// plausible-looking wrong number. The WINDOW stays here: it is a property of
// the mechanism and names nobody.
export const COMMISSION_WINDOW_MONTHS = 12; // first 12 months per referred account

// There is deliberately NO marketplace commission constant here (D-143).
//
// The D-58 pivot withheld 8%/3%/0% of the settled net before the teacher
// payout, which only worked because the money passed through the platform
// balance first. Under direct charges it does not: the charge settles on the
// teacher's own connected account. Withholding a cut would mean a Stripe
// application fee, and cross-border application-fee support is undocumented
// and known to fail for exactly the markets this platform is expanding into
// (MX, BR, IN, SG, TH). Nothing may be collected AT THE CHARGE.
//
// A take-rate is still available as a pricing decision — meter GMV from the
// webhook and bill it on the teacher's own subscription invoice, which works
// in every country. That is a billing feature and must never become a
// payments one.

// --- Helpers ---------------------------------------------------------------

// Any paid plan (everything except free).
export function isPaidPlan(plan: SubscriptionPlan): boolean {
  return plan !== "free";
}

// The monthly-equivalent of an ALREADY-KNOWN price (e.g. a subscriber's own
// persisted `lockedPriceMinorUnits`) for a plan's billing interval — annual
// halves to /12, month/none pass through unchanged. This does NOT look the
// price up from the config table, so it's the correct helper for MRR: a
// subscriber's locked price can (deliberately, for founding) differ from
// today's config table, and after D-99 it can also be in an older currency
// (MXN) than a newer subscriber's (GBP) — re-deriving from the table instead
// of the stored price would silently substitute the wrong figure, or blend
// two currencies' raw numbers as if they were one unit. Callers still own
// keeping same-currency amounts together (see admin-metrics.ts's
// currency-partitioned MRR).
export function monthlyEquivalentOfPrice(plan: SubscriptionPlan, priceMinorUnits: number): number {
  switch (PLAN_INTERVAL[plan]) {
    case "month":
      return priceMinorUnits;
    case "year":
      return Math.round(priceMinorUnits / 12);
    case "none":
      return 0;
  }
}

// The monthly-equivalent of a plan's CURRENT config-table price in a given
// currency — used for a not-yet-subscribed estimate (the pricing page), never
// for an existing subscriber's actual MRR (use monthlyEquivalentOfPrice with
// their stored lockedPriceMinorUnits for that). `currency` selects the price
// table (defaults to the canonical GBP currency).
export function monthlyEquivalentMinorUnits(
  plan: SubscriptionPlan,
  currency: string = "GBP",
): number {
  return monthlyEquivalentOfPrice(plan, planPriceMinorUnits(plan, currency));
}

// Resolve a plan from a Stripe Price id, via the env-configured price ids.
// Returns null when the id matches none (caller treats as unknown/ignore).
export function planForStripePriceId(
  priceId: string | null | undefined,
  priceIds: { monthly?: string; annual?: string; founding?: string },
): SubscriptionPlan | null {
  if (!priceId) return null;
  if (priceId === priceIds.monthly) return "monthly";
  if (priceId === priceIds.annual) return "annual";
  if (priceId === priceIds.founding) return "founding";
  return null;
}
