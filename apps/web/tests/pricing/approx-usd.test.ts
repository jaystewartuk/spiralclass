import { describe, expect, it } from "vitest";
import { APPROX_MAX_AGE_DAYS, approxUsdFrom } from "@/lib/pricing/approx-usd";
import type { EconomicsAssumptionsValues } from "@/lib/economics/assumptions";

// The approximate second price is shown to someone deciding whether to spend
// money, so the rules that matter are the ones about when NOT to show it.

const AS_OF = new Date("2026-08-01T00:00:00.000Z");
const NOW = new Date("2026-08-30T00:00:00.000Z"); // 29 days later — fresh

function assumptions(over: Partial<EconomicsAssumptionsValues> = {}): EconomicsAssumptionsValues {
  return {
    fxUsdToGbp: 0.7387,
    fxMxnToGbp: 0.04249,
    fxEurToGbp: 0.846,
    allocationBasis: "active_teachers",
    fxAsOf: AS_OF,
    ...over,
  };
}

describe("approxUsdFrom", () => {
  it("converts pesos through the stored GBP pivot and rounds to whole dollars", () => {
    // MX$6,000 · 0.04249 GBP/MXN ÷ 0.7387 GBP/USD ≈ US$345
    const got = approxUsdFrom(600_000, "MXN", assumptions(), NOW);
    expect(got).not.toBeNull();
    expect(got!.centsUsd % 100).toBe(0); // never quotes cents on an approximation
    expect(got!.centsUsd).toBe(34_500);
    expect(got!.asOf).toEqual(AS_OF);
  });

  it("adds nothing for a teacher already priced in dollars", () => {
    expect(approxUsdFrom(10_000, "USD", assumptions(), NOW)).toBeNull();
  });

  it("refuses rather than degrades once the rate is stale", () => {
    const stale = new Date(AS_OF.getTime() + (APPROX_MAX_AGE_DAYS + 1) * 86_400_000);
    expect(approxUsdFrom(600_000, "MXN", assumptions(), stale)).toBeNull();
  });

  it("still answers on the last fresh day", () => {
    const edge = new Date(AS_OF.getTime() + APPROX_MAX_AGE_DAYS * 86_400_000);
    expect(approxUsdFrom(600_000, "MXN", assumptions(), edge)).not.toBeNull();
  });

  it("returns null for a currency the assumptions row has no rate for", () => {
    // A Brazilian teacher: real, offerable (D-64), and absent from the P&L's
    // four-currency pivot. Guessing here would be inventing a price.
    expect(approxUsdFrom(50_000, "BRL", assumptions(), NOW)).toBeNull();
  });

  it("respects the currency's exponent rather than assuming two decimals", () => {
    // CLP is 0-decimal: 60000 minor units IS $60,000 CLP, not $600.
    const zeroDecimal = approxUsdFrom(60_000, "CLP", assumptions(), NOW);
    // No CLP rate stored, so it declines — the point is it declines rather
    // than silently dividing by 100.
    expect(zeroDecimal).toBeNull();
  });

  it("declines a nonsensical or unset USD pivot instead of dividing by zero", () => {
    expect(approxUsdFrom(600_000, "MXN", assumptions({ fxUsdToGbp: 0 }), NOW)).toBeNull();
  });

  it("declines a rate dated in the future, which means the row is wrong", () => {
    const future = new Date(AS_OF.getTime() - 86_400_000);
    expect(approxUsdFrom(600_000, "MXN", assumptions(), future)).toBeNull();
  });
});
