// Subscription / monetization config now lives in @spiralclass/shared so web
// and mobile resolve the same plan prices, caps, and windows. Re-exported here
// so existing `@/lib/subscriptions/config` imports keep working. Add new
// constants in packages/shared/src/subscriptions-config.ts.
export {
  SUBSCRIPTION_PLANS,
  type SubscriptionPlan,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
  PLAN_PRICE_MINOR_UNITS,
  PLAN_PRICE_MINOR_UNITS_BY_CURRENCY,
  planPriceMinorUnits,
  PLAN_INTERVAL,
  TRIAL_DAYS,
  PAST_DUE_GRACE_DAYS,
  TRIAL_ENDING_NOTICE_DAYS,
  FREE_MAX_ACTIVE_STUDENTS,
  FREE_MAX_PACKAGE_TEMPLATES,
  FOUNDING_MAX_TEACHERS,
  FOUNDING_WINDOW_DAYS,
  LAUNCH_DATE,
  foundingCutoffDate,
  isFoundingCohortOpen,
  COMMISSION_WINDOW_MONTHS,
  isPaidPlan,
  monthlyEquivalentMinorUnits,
  monthlyEquivalentOfPrice,
  planForStripePriceId,
} from "@spiralclass/shared";
