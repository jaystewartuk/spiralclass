import { describe, expect, it } from "vitest";
import type { EconomicsAssumptionsValues } from "@/lib/economics/assumptions";
import {
  summarizeIntegrationCosts,
  rollupByCategory,
  rollupByIntegration,
  totalCostPence,
  highestCostIntegration,
  highestCostCategory,
  grossMarginFraction,
  costPerUnit,
  type EstimateInput,
  type IntegrationEstimate,
} from "@/lib/economics/estimate";

// D-86 S3 — the Overview panel's pure cost math. All inputs here are
// pre-fetched plain objects; no DB dependency, mirroring
// money-metrics.test.ts's summarize* tests.

const ASSUMPTIONS: EconomicsAssumptionsValues = {
  fxUsdToGbp: 0.8,
  fxMxnToGbp: 0.05,
  fxEurToGbp: 0.9,
  allocationBasis: "active_teachers",
  fxAsOf: new Date("2026-07-01T00:00:00.000Z"),
};

function integration(over: Partial<EstimateInput> = {}): EstimateInput {
  return {
    key: "vercel",
    name: "Vercel",
    category: "hosting",
    currency: "USD",
    pricingModel: { kind: "free" },
    ...over,
  };
}

describe("summarizeIntegrationCosts", () => {
  it("estimates a resolved integration's native cost and GBP conversion", () => {
    const { estimates, unresolvedKeys } = summarizeIntegrationCosts(
      [integration({ pricingModel: { kind: "monthly", amountMinor: 2000, currency: "USD" } })],
      {},
      ASSUMPTIONS,
    );
    // $20.00 * 0.8 = £16.00 = 1600 pence.
    expect(estimates).toEqual([
      {
        key: "vercel",
        name: "Vercel",
        category: "hosting",
        currency: "USD",
        nativeCostMinor: 2000,
        gbpPence: 1600,
      },
    ]);
    expect(unresolvedKeys).toEqual([]);
  });

  it("marks an unparseable pricing model unresolved with null costs", () => {
    const { estimates, unresolvedKeys } = summarizeIntegrationCosts(
      [integration({ key: "broken", pricingModel: null })],
      {},
      ASSUMPTIONS,
    );
    expect(estimates[0].nativeCostMinor).toBeNull();
    expect(estimates[0].gbpPence).toBeNull();
    expect(unresolvedKeys).toEqual(["broken"]);
  });

  it("marks an unsupported currency unresolved even with a valid pricing model", () => {
    const { estimates, unresolvedKeys } = summarizeIntegrationCosts(
      [
        integration({
          key: "yen_thing",
          currency: "JPY",
          pricingModel: { kind: "monthly", amountMinor: 500, currency: "JPY" },
        }),
      ],
      {},
      ASSUMPTIONS,
    );
    expect(estimates[0].nativeCostMinor).toBe(500);
    expect(estimates[0].gbpPence).toBeNull();
    expect(unresolvedKeys).toEqual(["yen_thing"]);
  });

  it("evaluates usage-driven pricing against the passed-in usage snapshot", () => {
    const { estimates } = summarizeIntegrationCosts(
      [
        integration({
          key: "anthropic_api",
          pricingModel: {
            kind: "payg",
            metric: "ai_generations",
            unit: "generation",
            ratePerUnit: 2,
            currency: "USD",
          },
        }),
      ],
      { ai_generations: 100 },
      ASSUMPTIONS,
    );
    // 100 * 2 cents = 200 cents native, * 0.8 = 160 pence.
    expect(estimates[0].nativeCostMinor).toBe(200);
    expect(estimates[0].gbpPence).toBe(160);
  });
});

function estimate(over: Partial<IntegrationEstimate> = {}): IntegrationEstimate {
  return {
    key: "vercel",
    name: "Vercel",
    category: "hosting",
    currency: "USD",
    nativeCostMinor: 0,
    gbpPence: 0,
    ...over,
  };
}

describe("rollupByCategory", () => {
  it("sums resolved integrations into their category", () => {
    const totals = rollupByCategory([
      estimate({ category: "hosting", gbpPence: 500 }),
      estimate({ key: "fly_io", category: "hosting", gbpPence: 300 }),
      estimate({ key: "resend", category: "email", gbpPence: 100 }),
    ]);
    expect(totals.hosting).toBe(800);
    expect(totals.email).toBe(100);
    expect(totals.ai).toBe(0);
  });

  it("excludes unresolved (null gbpPence) integrations from the total", () => {
    const totals = rollupByCategory([estimate({ category: "hosting", gbpPence: null })]);
    expect(totals.hosting).toBe(0);
  });

  it("zero-fills every category, even ones with no integrations", () => {
    const totals = rollupByCategory([]);
    expect(totals.dev_tools).toBe(0);
    expect(totals.other).toBe(0);
  });
});

describe("rollupByIntegration", () => {
  it("keys resolved integrations by their key", () => {
    const totals = rollupByIntegration([
      estimate({ key: "vercel", gbpPence: 500 }),
      estimate({ key: "fly_io", gbpPence: 300 }),
    ]);
    expect(totals).toEqual({ vercel: 500, fly_io: 300 });
  });

  it("omits unresolved integrations rather than zero-valuing them", () => {
    const totals = rollupByIntegration([estimate({ key: "broken", gbpPence: null })]);
    expect(totals).toEqual({});
  });
});

describe("totalCostPence", () => {
  it("sums every resolved integration's GBP pence", () => {
    expect(
      totalCostPence([
        estimate({ gbpPence: 500 }),
        estimate({ gbpPence: 300 }),
        estimate({ gbpPence: null }),
      ]),
    ).toBe(800);
  });

  it("is 0 for an empty list", () => {
    expect(totalCostPence([])).toBe(0);
  });
});

describe("highestCostIntegration", () => {
  it("picks the single costliest resolved integration", () => {
    const result = highestCostIntegration([
      estimate({ key: "vercel", name: "Vercel", gbpPence: 500 }),
      estimate({ key: "fly_io", name: "Fly.io", gbpPence: 900 }),
      estimate({ key: "resend", name: "Resend", gbpPence: 100 }),
    ]);
    expect(result).toEqual({ key: "fly_io", name: "Fly.io", gbpPence: 900 });
  });

  it("ignores unresolved integrations", () => {
    const result = highestCostIntegration([
      estimate({ key: "broken", gbpPence: null }),
      estimate({ key: "vercel", name: "Vercel", gbpPence: 100 }),
    ]);
    expect(result?.key).toBe("vercel");
  });

  it("returns null when nothing resolved", () => {
    expect(highestCostIntegration([estimate({ gbpPence: null })])).toBeNull();
    expect(highestCostIntegration([])).toBeNull();
  });
});

describe("highestCostCategory", () => {
  it("picks the costliest category from a rollup", () => {
    const result = highestCostCategory({
      ai: 100,
      video: 900,
      hosting: 500,
      database: 0,
      storage: 0,
      analytics: 0,
      authentication: 0,
      email: 0,
      payments: 0,
      notifications: 0,
      monitoring: 0,
      dev_tools: 0,
      other: 0,
    });
    expect(result).toEqual({ category: "video", gbpPence: 900 });
  });

  it("returns null when every category totals 0", () => {
    const result = highestCostCategory({
      ai: 0,
      video: 0,
      hosting: 0,
      database: 0,
      storage: 0,
      analytics: 0,
      authentication: 0,
      email: 0,
      payments: 0,
      notifications: 0,
      monitoring: 0,
      dev_tools: 0,
      other: 0,
    });
    expect(result).toBeNull();
  });
});

describe("grossMarginFraction", () => {
  it("computes profit / revenue", () => {
    expect(grossMarginFraction(1000, 250)).toBe(0.25);
  });

  it("returns null when there's no revenue to divide by", () => {
    expect(grossMarginFraction(0, -500)).toBeNull();
  });

  it("can go negative when costs exceed revenue", () => {
    expect(grossMarginFraction(1000, -200)).toBe(-0.2);
  });
});

describe("costPerUnit", () => {
  it("divides total cost evenly across the unit count, rounded", () => {
    expect(costPerUnit(1000, 3)).toBe(333);
  });

  it("returns null when the unit count is 0 — a per-unit cost is meaningless", () => {
    expect(costPerUnit(1000, 0)).toBeNull();
  });
});
