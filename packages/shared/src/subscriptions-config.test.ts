import { describe, expect, it } from "vitest";
import {
  PLAN_PRICE_MINOR_UNITS,
  PLAN_PRICE_MINOR_UNITS_BY_CURRENCY,
  monthlyEquivalentMinorUnits,
  monthlyEquivalentOfPrice,
  planPriceMinorUnits,
} from "./subscriptions-config";

describe("planPriceMinorUnits", () => {
  it("returns the GBP price by default (canonical billing currency as of D-99)", () => {
    expect(planPriceMinorUnits("monthly")).toBe(799);
    expect(planPriceMinorUnits("annual")).toBe(7_990);
    expect(planPriceMinorUnits("founding")).toBe(599);
    expect(planPriceMinorUnits("free")).toBe(0);
  });

  it("resolves the explicit GBP table and is case-insensitive", () => {
    expect(planPriceMinorUnits("monthly", "GBP")).toBe(799);
    expect(planPriceMinorUnits("monthly", "gbp")).toBe(799);
  });

  it("still resolves the frozen pre-D-99 MXN table for a legacy subscriber", () => {
    expect(planPriceMinorUnits("monthly", "MXN")).toBe(19_900);
    expect(planPriceMinorUnits("annual", "MXN")).toBe(199_000);
    expect(planPriceMinorUnits("founding", "MXN")).toBe(14_900);
  });

  it("falls back to the GBP table for a currency with no price table yet", () => {
    expect(planPriceMinorUnits("monthly", "USD")).toBe(
      PLAN_PRICE_MINOR_UNITS_BY_CURRENCY.GBP.monthly,
    );
  });

  it("keeps the back-compat PLAN_PRICE_MINOR_UNITS alias pointed at the canonical GBP table", () => {
    expect(PLAN_PRICE_MINOR_UNITS).toBe(PLAN_PRICE_MINOR_UNITS_BY_CURRENCY.GBP);
  });
});

describe("monthlyEquivalentOfPrice", () => {
  it("normalizes annual to a monthly figure from an already-known price, ignoring the config table", () => {
    expect(monthlyEquivalentOfPrice("monthly", 799)).toBe(799);
    expect(monthlyEquivalentOfPrice("annual", 7_990)).toBe(Math.round(7_990 / 12));
    expect(monthlyEquivalentOfPrice("founding", 599)).toBe(599);
    expect(monthlyEquivalentOfPrice("free", 0)).toBe(0);
    // A legacy MXN subscriber's own locked price works the same way — this
    // helper never re-derives from a currency table.
    expect(monthlyEquivalentOfPrice("annual", 199_000)).toBe(Math.round(199_000 / 12));
  });
});

describe("monthlyEquivalentMinorUnits", () => {
  it("normalizes annual to a monthly figure and passes the currency through", () => {
    expect(monthlyEquivalentMinorUnits("monthly")).toBe(799);
    expect(monthlyEquivalentMinorUnits("annual")).toBe(Math.round(7_990 / 12));
    expect(monthlyEquivalentMinorUnits("free")).toBe(0);
    expect(monthlyEquivalentMinorUnits("monthly", "MXN")).toBe(19_900);
  });
});
