// Card-fee constants + Stripe/manual-rail price helpers live in
// @spiralclass/shared so web and mobile pricing UIs compute identical
// suggestions. Re-exported here for existing `@/lib/pricing/stripe-fee`
// imports.
//
// The constants dropped their `_UK_` infix at D-152: since D-143 the charge
// settles on the TEACHER's own connected account at her country's Stripe rate,
// so nothing here is Stripe UK's rate card any more. `STRIPE_WORST_CASE_RATE`
// is the platform's deliberately-pessimistic upper bound used to size a
// suggested transfer discount — never quote it to a teacher as "what Stripe
// charges". See that module's header.
export {
  STRIPE_INTERNATIONAL_RATE,
  STRIPE_CURRENCY_CONVERSION_RATE,
  STRIPE_FIXED_FEE_MINOR_UNITS,
  STRIPE_WORST_CASE_RATE,
  STRIPE_PRICING_URL,
  stripeWorstCaseRatePercent,
  computeWisePriceFromStripe,
  suggestStripePriceFromWise,
} from "@spiralclass/shared";
