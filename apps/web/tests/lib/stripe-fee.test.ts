import { describe, expect, it } from "vitest";
import { computeWisePriceFromStripe, suggestStripePriceFromWise } from "@/lib/pricing/stripe-fee";

// Worst-case Stripe UK rate: 3.25% (international card) + 2% (currency
// conversion) = 5.25%, plus a 30-minor-unit fixed fee. The teacher bears the
// actual fee under separate-charges-and-transfers, so the suggested manual-rail
// price must sit at or below what a real card charge would leave her.
//
// This replaced a single-market rate table on 2026-08-25 — one country's card
// rates and fixed fee, applied to every teacher on the platform regardless of
// where her charge actually settles.

describe("computeWisePriceFromStripe", () => {
  it("returns 0 for zero or negative inputs", () => {
    expect(computeWisePriceFromStripe(0, "GBP")).toBe(0);
    expect(computeWisePriceFromStripe(-100, "GBP")).toBe(0);
  });

  it("nets the worst-case fee for a 1,300.00 charge", () => {
    // 130000 × (1 - 0.0525) - 30 = 123,145 → floor to whole unit = 123,100
    expect(computeWisePriceFromStripe(130_000, "GBP")).toBe(123_100);
  });

  it("nets the worst-case fee for a 500.00 charge", () => {
    // 50000 × 0.9475 - 30 = 47,345 → 47,300
    expect(computeWisePriceFromStripe(50_000, "GBP")).toBe(47_300);
  });

  it("floors the result so the teacher is never under-compensated", () => {
    // 80000 × 0.9475 - 30 = 75,770 → 75,700, not 75,770
    expect(computeWisePriceFromStripe(80_000, "GBP")).toBe(75_700);
  });

  it("returns whole major units", () => {
    for (const cents of [10_000, 12_345, 99_999, 1_000_000]) {
      expect(computeWisePriceFromStripe(cents, "GBP") % 100).toBe(0);
    }
  });

  // Guard against a silent reversion to the old single-market table: that one
  // netted 120,000 on the same input, because it assumed a higher blended rate
  // and a fixed fee 10x larger in the currency it is actually read as.
  it("does not use the retired single-market rate or fixed fee", () => {
    expect(computeWisePriceFromStripe(130_000, "GBP")).not.toBe(120_000);
  });
});

describe("suggestStripePriceFromWise", () => {
  it("returns 0 for zero or negative inputs", () => {
    expect(suggestStripePriceFromWise(0, "GBP")).toBe(0);
    expect(suggestStripePriceFromWise(-100, "GBP")).toBe(0);
  });

  it("marks a target up to a clean 5-unit headline that covers the fee", () => {
    // 130.00 → (13000 + 30) / 0.9475 = 13,752.0 → ceil to 5 units → 14,000
    expect(suggestStripePriceFromWise(13_000, "GBP")).toBe(14_000);
    // 240.00 → 25,375.7 → 25,500
    expect(suggestStripePriceFromWise(24_000, "GBP")).toBe(25_500);
    // 280.00 → 29,598.9 → 30,000
    expect(suggestStripePriceFromWise(28_000, "GBP")).toBe(30_000);
    // 550.00 → 58,100.3 → 58,500
    expect(suggestStripePriceFromWise(55_000, "GBP")).toBe(58_500);
  });

  it("guarantees the teacher nets at least her target after the worst-case fee", () => {
    for (const wise of [5_000, 13_000, 24_000, 28_000, 55_000, 99_999]) {
      const stripe = suggestStripePriceFromWise(wise, "GBP");
      expect(computeWisePriceFromStripe(stripe, "GBP")).toBeGreaterThanOrEqual(
        Math.floor(wise / 100) * 100,
      );
    }
  });

  it("returns a value rounded to whole 5-unit increments", () => {
    for (const wise of [5_000, 13_000, 24_000, 28_000, 55_000, 99_999]) {
      expect(suggestStripePriceFromWise(wise, "GBP") % 500).toBe(0);
    }
  });
});
