// Card-fee constants used to size the default transfer-rail discount, and the
// ONE place the teacher-facing fee disclosure gets its numbers from.
//
// ⚠️ SCOPE CHANGED AT D-143, AND THE OLD JUSTIFICATION IS GONE. This table used
// to be Stripe UK's, and that was defensible because the Stripe rail existed
// only for teachers in the cross-border payout circle, who priced in GBP, USD
// or EUR — all 2-decimal, so `/100` was a fact rather than an assumption.
//
// Under direct charges neither half holds. The charge settles on the TEACHER's
// own connected account, so she pays HER country's Stripe rate (Mexico and
// Japan are nearer 3.6%, the US 2.9%, the UK 1.5%), and she prices in her own
// currency — which may be 0-decimal (JPY, CLP, KRW, VND). The minor-unit
// arithmetic below is therefore currency-aware now; getting that wrong is a
// 100x error, not a rounding one.
//
// The constants were named `STRIPE_UK_*` until D-152. They are not UK-specific
// any more and never should have read as Stripe's published UK rate card once
// the charge moved onto the teacher's own account — the rename is so no caller
// can present this as "what Stripe charges", which it is not.
//
// The RATE remains a single deliberately-pessimistic number rather than a
// per-country table. It only sizes a SUGGESTED discount the teacher can edit,
// and biasing high means the suggestion never leaves her worse off on the
// transfer rail than on cards — the only direction that cannot cost her money.
// A per-country fee table would be the honest fix if this ever became binding.
//
// ⚠️ IT IS NOT A PRICE CLAIM, AND MUST NEVER BE PRESENTED AS ONE (D-152).
// `STRIPE_WORST_CASE_RATE` is OUR pessimistic upper bound, not Stripe's rate
// for any particular teacher. Teacher-facing copy quotes
// `DISCLOSED_CARD_FEE_RANGE` — the honest span of Stripe's own published
// rates — and always attributes the fee to Stripe rather than to SpiralClass.
// Quoting 5.25% as "Stripe charges you" is both wrong for nearly every teacher
// and a price claim the platform cannot stand behind.
//
// There is deliberately NO single-market table here any more. The rates it
// carried were one country's, applied to every teacher on the platform, which
// read as £3.00 of fixed fee for a teacher pricing in GBP.
//
// We bias to the worst case: an international (non-UK, non-EEA) card at 3.25%
// plus the 2% currency-conversion surcharge, and the fixed fee at the top of
// the GBP/EUR/USD range. Most charges cost the teacher less than this, so the
// auto-computed transfer discount is on the conservative side — the teacher
// nets at least as much on the manual rail as she would after a real card fee,
// never less, which is the direction that cannot cost her money.
//
// Published refs (Stripe UK pricing; verify when Stripe changes them):
//   UK domestic card:     1.5%  + 20p
//   EEA card:             2.5%  + 20p
//   International card:   3.25% + 20p
//   Currency conversion:  +2% when the card's currency differs from the charge's
//
// Shared so the web and mobile pricing UIs compute identical suggestions
// instead of re-deriving the formula per platform.
import { currencyExponent } from "./money";

export const STRIPE_INTERNATIONAL_RATE = 0.0325;
export const STRIPE_CURRENCY_CONVERSION_RATE = 0.02;
// 30 minor units: 20p for a GBP charge, and comfortably above the local
// equivalent for a EUR or USD one. One number rather than a per-currency table
// because all three are the same order of magnitude and the estimate is
// deliberately generous.
export const STRIPE_FIXED_FEE_MINOR_UNITS = 30;
export const STRIPE_WORST_CASE_RATE = STRIPE_INTERNATIONAL_RATE + STRIPE_CURRENCY_CONVERSION_RATE;

/**
 * Stripe's own pricing page, the ONLY figure the platform points a teacher at
 * for what a card payment will actually cost her.
 *
 * D-152: public marketing surfaces deliberately quote NO percentage. Under
 * direct charges the rate is Stripe's, set per country and per card type, and
 * the platform has no way to know which one applies to a given teacher or a
 * given charge. Publishing a number we cannot stand behind on a page that also
 * says "0% commission" is precisely the price claim that turns an honest
 * disclosure into a misleading one. So the disclosure names WHO charges the
 * fee, says the platform receives none of it, and links here.
 */
export const STRIPE_PRICING_URL = "https://stripe.com/pricing";

/**
 * The platform's own worst-case rate as a percentage, for in-product copy that
 * has to name a number because it is explaining a suggested price.
 *
 * ALWAYS present this as SpiralClass's deliberately-high estimate, never as
 * "what Stripe charges" — it is the international-card rate plus the
 * currency-conversion surcharge, which most charges do not incur. See the
 * module header.
 */
export function stripeWorstCaseRatePercent(): number {
  return Math.round(STRIPE_WORST_CASE_RATE * 10_000) / 100;
}

// One whole major unit, in minor units, for `currency`. Replaces a hardcoded
// 100: since D-143 a card-rail teacher can price in a 0-decimal currency, where
// a whole major unit IS one minor unit.
function majorUnitStep(currency: string): number {
  return 10 ** currencyExponent(currency);
}

/**
 * Compute the manual-rail price that leaves the teacher with the same net
 * amount she would receive after Stripe's worst-case processing fee. Floors to
 * a whole major unit so the displayed price is a clean integer and the
 * discount can never overshoot what the fee actually costs her.
 */
export function computeWisePriceFromStripe(stripeMinorUnits: number, currency: string): number {
  if (stripeMinorUnits <= 0) return 0;
  const step = majorUnitStep(currency);
  const net = stripeMinorUnits * (1 - STRIPE_WORST_CASE_RATE) - STRIPE_FIXED_FEE_MINOR_UNITS;
  return Math.max(0, Math.floor(net / step) * step);
}

// Round suggested card prices up to the nearest 5 major units (£5 / €5 / $5 /
// ¥5) so the headline reads as a clean retail number (30, not 28.47). Expressed
// in MAJOR units and scaled per currency: as a flat 500 minor units this was
// ¥500 for a 0-decimal currency where 5 major units is 5.
const SUGGEST_ROUNDING_MAJOR_UNITS = 5;

function suggestRoundingStep(currency: string): number {
  return SUGGEST_ROUNDING_MAJOR_UNITS * majorUnitStep(currency);
}

/**
 * Invert {@link computeWisePriceFromStripe}: given a target net amount the
 * teacher wants to receive on Wise (typically her existing cash/transfer
 * price), return a clean Stripe headline price such that the auto-computed
 * manual-rail discount lands at or just above the target. Rounds UP so the
 * suggestion never under-shoots the teacher's target.
 */
export function suggestStripePriceFromWise(targetWiseMinorUnits: number, currency: string): number {
  if (targetWiseMinorUnits <= 0) return 0;
  const step = majorUnitStep(currency);
  // computeWisePriceFromStripe FLOORS its result to a whole major unit, so
  // inverting the raw target can round-trip just short of the never-undershoot
  // contract when the target isn't a whole-unit multiple. Invert against the
  // target rounded UP to the next whole unit so the floored manual-rail price
  // can never land below the raw target.
  const wholeUnitTarget = Math.ceil(targetWiseMinorUnits / step) * step;
  const exact = (wholeUnitTarget + STRIPE_FIXED_FEE_MINOR_UNITS) / (1 - STRIPE_WORST_CASE_RATE);
  const rounding = suggestRoundingStep(currency);
  return Math.ceil(exact / rounding) * rounding;
}
