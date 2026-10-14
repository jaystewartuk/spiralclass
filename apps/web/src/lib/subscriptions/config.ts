// Subscription / monetization config lives in @spiralclass/shared so the
// handlers and the UI resolve the same plan prices, caps and windows.
// Re-exported here as the import surface the app uses. Add new constants in
// packages/shared/src/subscriptions-config.ts.
export {
  type SubscriptionPlan,
  type SubscriptionStatus,
  PLAN_PRICE_MINOR_UNITS,
  planPriceMinorUnits,
  TRIAL_DAYS,
  PAST_DUE_GRACE_DAYS,
  TRIAL_ENDING_NOTICE_DAYS,
  FREE_MAX_ACTIVE_STUDENTS,
  FREE_MAX_PACKAGE_TEMPLATES,
  FOUNDING_MAX_TEACHERS,
  foundingCutoffDate,
  COMMISSION_WINDOW_MONTHS,
  isPaidPlan,
  monthlyEquivalentMinorUnits,
  monthlyEquivalentOfPrice,
  planForStripePriceId,
} from "@spiralclass/shared";
