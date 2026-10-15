// The Stripe/manual-rail price helpers live in @spiralclass/shared
// (pricing-fees.ts), beside the card-fee estimate they are computed from.
// Re-exported here as the import surface the pricing UI uses.
//
// `stripeWorstCaseRatePercent` is the platform's deliberately-pessimistic upper
// bound, used to size a suggested transfer discount — never quote it to a
// teacher as "what Stripe charges" (D-152). See that module's header.
export {
  stripeWorstCaseRatePercent,
  computeWisePriceFromStripe,
  suggestStripePriceFromWise,
} from "@spiralclass/shared";
