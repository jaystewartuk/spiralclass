import { describe, expect, it } from "vitest";
import { computeWisePriceFromStripe, suggestStripePriceFromWise } from "./pricing-fees";

describe("computeWisePriceFromStripe", () => {
  it("returns a floored-to-whole-unit net below the Stripe price", () => {
    const wise = computeWisePriceFromStripe(150_000, "GBP");
    expect(wise).toBeLessThan(150_000);
    expect(wise % 100).toBe(0); // whole major units
  });

  // The worst case is an international card (3.25%) plus the 2% conversion
  // surcharge plus a 30-minor-unit fixed fee — NOT the Mexican
  // 6.4% + 16% IVA + $3 MXN this replaced. £1,500.00 in pence:
  //   150000 * (1 - 0.0525) - 30 = 142,095 -> floored to 142,000.
  it("applies the platform worst case, not Mexico's", () => {
    expect(computeWisePriceFromStripe(150_000, "GBP")).toBe(142_000);
  });

  it("never returns negative", () => {
    expect(computeWisePriceFromStripe(0, "GBP")).toBe(0);
    expect(computeWisePriceFromStripe(-100, "GBP")).toBe(0);
  });
});

describe("suggestStripePriceFromWise", () => {
  it("rounds the suggestion up to the nearest 5 major units", () => {
    const stripe = suggestStripePriceFromWise(120_000, "GBP");
    expect(stripe % 500).toBe(0);
  });

  it("never under-shoots: the computed Wise discount lands at or above target", () => {
    const target = 120_000;
    const stripe = suggestStripePriceFromWise(target, "GBP");
    expect(computeWisePriceFromStripe(stripe, "GBP")).toBeGreaterThanOrEqual(target);
  });

  // Regression: computeWisePriceFromStripe floors to the whole major unit, so
  // a fractional target used to round-trip up to 99 minor units short of the
  // documented never-undershoot contract. Sweep whole-unit + fractional
  // targets and assert the invariant holds for all of them.
  it("never under-shoots for fractional targets either", () => {
    for (let base = 10_000; base <= 500_000; base += 4_437) {
      for (const frac of [0, 1, 37, 50, 99]) {
        const target = base + frac;
        const stripe = suggestStripePriceFromWise(target, "GBP");
        expect(computeWisePriceFromStripe(stripe, "GBP")).toBeGreaterThanOrEqual(target);
      }
    }
  });

  it("returns 0 for non-positive targets", () => {
    expect(suggestStripePriceFromWise(0, "GBP")).toBe(0);
  });
});

// D-143 widened the card rail past the old Connect cross-border circle, so a
// card-rail teacher can now price in a 0-decimal currency (JPY, CLP, KRW, VND).
// Both helpers used to hardcode 100 minor units per major unit, which for those
// currencies is a 100x error, not a rounding one: "floor to a whole major unit"
// would have floored 1,480 yen to 1,400, and the 5-unit suggestion step would
// have been 500 yen.
describe("zero-decimal currencies (D-143)", () => {
  it("floors to a whole major unit of ONE minor unit, not 100", () => {
    // Every integer is already a whole major unit in JPY, so the only rounding
    // is the fee itself — the result must not be snapped to a multiple of 100.
    const jpy = computeWisePriceFromStripe(1_480, "JPY");
    const gbp = computeWisePriceFromStripe(1_480, "GBP");
    expect(jpy).toBeLessThan(1_480);
    // The GBP result is floored to whole pounds; the JPY one is not floored to
    // hundreds of yen. If the exponent were ignored these would be equal.
    expect(gbp % 100).toBe(0);
    expect(jpy).toBeGreaterThan(gbp);
  });

  it("rounds the suggestion to 5 major units, not 500", () => {
    const jpy = suggestStripePriceFromWise(1_000, "JPY");
    expect(jpy % 5).toBe(0);
    // A 500-minor-unit step would force every JPY suggestion to a multiple of
    // 500; the bug this guards is a 1,000 yen target suggesting 5,000 yen.
    expect(jpy).toBeLessThan(2_000);
  });

  it("still never undershoots the teacher's target in a 0-decimal currency", () => {
    for (const target of [500, 1_000, 1_480, 3_333, 12_000]) {
      const headline = suggestStripePriceFromWise(target, "JPY");
      expect(computeWisePriceFromStripe(headline, "JPY")).toBeGreaterThanOrEqual(target);
    }
  });
});
