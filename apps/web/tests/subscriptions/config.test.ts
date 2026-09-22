import { describe, expect, it } from "vitest";
import {
  FOUNDING_MAX_TEACHERS,
  PLAN_PRICE_MINOR_UNITS,
  isFoundingCohortOpen,
  isPaidPlan,
  monthlyEquivalentMinorUnits,
  planForStripePriceId,
  foundingCutoffDate,
} from "@/lib/subscriptions/config";

describe("plan prices", () => {
  it("matches the documented canonical GBP prices (pence, D-99)", () => {
    expect(PLAN_PRICE_MINOR_UNITS.free).toBe(0);
    expect(PLAN_PRICE_MINOR_UNITS.monthly).toBe(799); // £7.99
    expect(PLAN_PRICE_MINOR_UNITS.annual).toBe(7_990); // £79.90
    expect(PLAN_PRICE_MINOR_UNITS.founding).toBe(599); // £5.99
  });

  it("isPaidPlan: free is the only non-paid plan", () => {
    expect(isPaidPlan("free")).toBe(false);
    expect(isPaidPlan("monthly")).toBe(true);
    expect(isPaidPlan("annual")).toBe(true);
    expect(isPaidPlan("founding")).toBe(true);
  });

  it("monthlyEquivalentMinorUnits normalizes annual to ~£6.66/mo", () => {
    expect(monthlyEquivalentMinorUnits("monthly")).toBe(799);
    expect(monthlyEquivalentMinorUnits("founding")).toBe(599);
    expect(monthlyEquivalentMinorUnits("annual")).toBe(Math.round(7_990 / 12));
    expect(monthlyEquivalentMinorUnits("free")).toBe(0);
  });
});

describe("planForStripePriceId", () => {
  const ids = { monthly: "price_m", annual: "price_a", founding: "price_f" };
  it("resolves each configured price id to its plan", () => {
    expect(planForStripePriceId("price_m", ids)).toBe("monthly");
    expect(planForStripePriceId("price_a", ids)).toBe("annual");
    expect(planForStripePriceId("price_f", ids)).toBe("founding");
  });
  it("returns null for an unknown / missing price id", () => {
    expect(planForStripePriceId("price_zzz", ids)).toBeNull();
    expect(planForStripePriceId(null, ids)).toBeNull();
  });
});

describe("founding cohort gate (cap AND cutoff)", () => {
  const launch = new Date("2026-05-27T00:00:00Z");
  const cutoff = foundingCutoffDate(launch); // launch + 90 days

  it("open while under cap AND before cutoff", () => {
    expect(
      isFoundingCohortOpen({
        foundingHeadcount: 10,
        now: new Date("2026-06-12T00:00:00Z"),
        launch,
      }),
    ).toBe(true);
  });

  it("closed once the headcount cap is reached", () => {
    expect(
      isFoundingCohortOpen({
        foundingHeadcount: FOUNDING_MAX_TEACHERS,
        now: new Date("2026-06-12T00:00:00Z"),
        launch,
      }),
    ).toBe(false);
  });

  it("closed once the cutoff date passes (even under cap)", () => {
    expect(
      isFoundingCohortOpen({
        foundingHeadcount: 1,
        now: new Date(cutoff.getTime() + 1000),
        launch,
      }),
    ).toBe(false);
  });
});
