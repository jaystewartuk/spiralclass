import { describe, expect, it } from "vitest";
import {
  addMonths,
  estimateExhaustionMonth,
  estimateMonthlyCostMinor,
  freeTierStatus,
  parsePricingModel,
  pricingModelSchema,
  resolveFreeTier,
  type PricingModel,
} from "./economics-pricing";

describe("estimateMonthlyCostMinor", () => {
  it("free is always 0", () => {
    expect(estimateMonthlyCostMinor({ kind: "free" }, {})).toBe(0);
    expect(estimateMonthlyCostMinor({ kind: "free" }, { emails: 999999 })).toBe(0);
  });

  it("monthly is the flat fee regardless of usage", () => {
    const m: PricingModel = { kind: "monthly", amountMinor: 2000, currency: "USD" };
    expect(estimateMonthlyCostMinor(m, {})).toBe(2000);
    expect(estimateMonthlyCostMinor(m, { lessons: 500 })).toBe(2000);
  });

  it("annual amortizes across 12 months (rounded)", () => {
    expect(
      estimateMonthlyCostMinor({ kind: "annual", amountMinor: 1200, currency: "USD" }, {}),
    ).toBe(100);
    // 1990/12 = 165.83 → 166
    expect(
      estimateMonthlyCostMinor({ kind: "annual", amountMinor: 1990, currency: "USD" }, {}),
    ).toBe(166);
  });

  describe("payg", () => {
    const m: PricingModel = {
      kind: "payg",
      metric: "emails",
      unit: "email",
      ratePerUnit: 2,
      currency: "USD",
    };

    it("bills every unit when there is no included allowance", () => {
      expect(estimateMonthlyCostMinor(m, { emails: 100 })).toBe(200);
    });

    it("treats a missing metric as zero usage", () => {
      expect(estimateMonthlyCostMinor(m, {})).toBe(0);
    });

    it("subtracts the included allowance before billing", () => {
      const withIncluded: PricingModel = { ...m, includedUnits: 30 } as PricingModel;
      expect(estimateMonthlyCostMinor(withIncluded, { emails: 100 })).toBe(140);
    });

    it("is 0 when usage is under the included allowance", () => {
      const withIncluded: PricingModel = { ...m, includedUnits: 3000 } as PricingModel;
      expect(estimateMonthlyCostMinor(withIncluded, { emails: 2000 })).toBe(0);
    });

    it("rounds a fractional rate at the boundary", () => {
      const frac: PricingModel = { ...m, ratePerUnit: 0.43 } as PricingModel;
      // 1000 * 0.43 = 430
      expect(estimateMonthlyCostMinor(frac, { emails: 1000 })).toBe(430);
      const odd: PricingModel = { ...m, ratePerUnit: 0.333 } as PricingModel;
      // 10 * 0.333 = 3.33 → 3
      expect(estimateMonthlyCostMinor(odd, { emails: 10 })).toBe(3);
    });
  });

  describe("tiered graduated", () => {
    const m: PricingModel = {
      kind: "tiered",
      metric: "video_minutes",
      mode: "graduated",
      tiers: [
        { upToUnits: 10, ratePerUnit: 5 },
        { upToUnits: 30, ratePerUnit: 3 },
        { upToUnits: null, ratePerUnit: 1 },
      ],
      currency: "USD",
    };

    it("prices each band's slice at that band's rate", () => {
      // 10*5 + 15*3 = 50 + 45 = 95
      expect(estimateMonthlyCostMinor(m, { video_minutes: 25 })).toBe(95);
    });

    it("uses the unbounded final band for the remainder", () => {
      // 10*5 + 20*3 + 60*1 = 50 + 60 + 60 = 170
      expect(estimateMonthlyCostMinor(m, { video_minutes: 90 })).toBe(170);
    });

    it("subtracts includedUnits first", () => {
      const withIncluded: PricingModel = { ...m, includedUnits: 5 } as PricingModel;
      // billable 20 → 10*5 + 10*3 = 80
      expect(estimateMonthlyCostMinor(withIncluded, { video_minutes: 25 })).toBe(80);
    });

    it("spills over a finite final band at the last rate", () => {
      const finite: PricingModel = {
        kind: "tiered",
        metric: "video_minutes",
        mode: "graduated",
        tiers: [{ upToUnits: 10, ratePerUnit: 5 }],
        currency: "USD",
      };
      // 10*5 + 5*5 = 75
      expect(estimateMonthlyCostMinor(finite, { video_minutes: 15 })).toBe(75);
    });
  });

  describe("tiered volume", () => {
    const m: PricingModel = {
      kind: "tiered",
      metric: "video_minutes",
      mode: "volume",
      tiers: [
        { upToUnits: 10, ratePerUnit: 5 },
        { upToUnits: 30, ratePerUnit: 3 },
        { upToUnits: null, ratePerUnit: 1 },
      ],
      currency: "USD",
    };

    it("prices ALL units at the single band the total lands in", () => {
      // 25 lands in the ≤30 band → 25*3 = 75
      expect(estimateMonthlyCostMinor(m, { video_minutes: 25 })).toBe(75);
    });

    it("uses the unbounded band past the last finite cap", () => {
      // 40 > 30 → unbounded band → 40*1 = 40
      expect(estimateMonthlyCostMinor(m, { video_minutes: 40 })).toBe(40);
    });
  });

  it("hybrid sums its components", () => {
    const m: PricingModel = {
      kind: "hybrid",
      components: [
        { kind: "monthly", amountMinor: 1000, currency: "USD" },
        {
          kind: "payg",
          metric: "emails",
          unit: "email",
          ratePerUnit: 2,
          currency: "USD",
        },
      ],
    };
    // 1000 + (100*2) = 1200
    expect(estimateMonthlyCostMinor(m, { emails: 100 })).toBe(1200);
  });
});

describe("resolveFreeTier / freeTierStatus", () => {
  it("a plain monthly plan has no free tier", () => {
    const m: PricingModel = { kind: "monthly", amountMinor: 2000, currency: "USD" };
    expect(resolveFreeTier(m)).toBeNull();
    expect(freeTierStatus(m, { lessons: 5 })).toBeNull();
  });

  it("payg includedUnits is a free allowance on its metric", () => {
    const m: PricingModel = {
      kind: "payg",
      metric: "emails",
      unit: "email",
      ratePerUnit: 2,
      includedUnits: 3000,
      currency: "USD",
    };
    expect(resolveFreeTier(m)).toEqual({ metric: "emails", allowance: 3000 });
    expect(freeTierStatus(m, { emails: 2000 })).toEqual({
      metric: "emails",
      allowance: 3000,
      used: 2000,
      remaining: 1000,
      exhausted: false,
    });
    expect(freeTierStatus(m, { emails: 3000 })?.exhausted).toBe(true);
    expect(freeTierStatus(m, { emails: 3200 })?.remaining).toBe(0);
  });

  it("an explicit top-level freeTier wins over includedUnits", () => {
    const m: PricingModel = {
      kind: "payg",
      metric: "emails",
      unit: "email",
      ratePerUnit: 2,
      includedUnits: 3000,
      currency: "USD",
      freeTier: { metric: "storage_gb", allowance: 5 },
    };
    expect(resolveFreeTier(m)).toEqual({ metric: "storage_gb", allowance: 5 });
  });

  it("a zero includedUnits is not a free tier", () => {
    const m: PricingModel = {
      kind: "payg",
      metric: "emails",
      unit: "email",
      ratePerUnit: 2,
      includedUnits: 0,
      currency: "USD",
    };
    expect(resolveFreeTier(m)).toBeNull();
  });

  it("hybrid resolves to the first component that has a free tier", () => {
    const m: PricingModel = {
      kind: "hybrid",
      components: [
        { kind: "monthly", amountMinor: 1000, currency: "USD" },
        {
          kind: "payg",
          metric: "video_minutes",
          unit: "minute",
          ratePerUnit: 1,
          includedUnits: 500,
          currency: "USD",
        },
      ],
    };
    expect(resolveFreeTier(m)).toEqual({ metric: "video_minutes", allowance: 500 });
  });
});

describe("estimateExhaustionMonth", () => {
  const withTier: PricingModel = {
    kind: "payg",
    metric: "emails",
    unit: "email",
    ratePerUnit: 1,
    includedUnits: 3000,
    currency: "USD",
  };

  it("returns null when the model has no free tier", () => {
    const m: PricingModel = { kind: "monthly", amountMinor: 2000, currency: "USD" };
    expect(estimateExhaustionMonth(m, [{ month: "2026-01", value: 10 }])).toBeNull();
  });

  it("returns null with no history", () => {
    expect(estimateExhaustionMonth(withTier, [])).toBeNull();
  });

  it("returns null from a single point below the allowance (no trend)", () => {
    expect(estimateExhaustionMonth(withTier, [{ month: "2026-03", value: 1000 }])).toBeNull();
  });

  it("returns the latest month when already at/over the allowance", () => {
    expect(
      estimateExhaustionMonth(withTier, [
        { month: "2026-01", value: 2000 },
        { month: "2026-02", value: 3200 },
      ]),
    ).toBe("2026-02");
  });

  it("projects the trailing run-rate to the crossing month", () => {
    // growth 500/mo from 2000 at 2026-03 → need 1000 more → 2 months → 2026-05
    expect(
      estimateExhaustionMonth(withTier, [
        { month: "2026-01", value: 1000 },
        { month: "2026-02", value: 1500 },
        { month: "2026-03", value: 2000 },
      ]),
    ).toBe("2026-05");
  });

  it("returns null for flat or declining usage", () => {
    expect(
      estimateExhaustionMonth(withTier, [
        { month: "2026-01", value: 1000 },
        { month: "2026-02", value: 1000 },
      ]),
    ).toBeNull();
    expect(
      estimateExhaustionMonth(withTier, [
        { month: "2026-01", value: 2000 },
        { month: "2026-02", value: 1500 },
      ]),
    ).toBeNull();
  });

  it("is order-independent (sorts history by month)", () => {
    expect(
      estimateExhaustionMonth(withTier, [
        { month: "2026-03", value: 2000 },
        { month: "2026-01", value: 1000 },
        { month: "2026-02", value: 1500 },
      ]),
    ).toBe("2026-05");
  });
});

describe("addMonths", () => {
  it("adds months with year rollover", () => {
    expect(addMonths("2026-11", 3)).toBe("2027-02");
    expect(addMonths("2026-03", 0)).toBe("2026-03");
    expect(addMonths("2026-01", 12)).toBe("2027-01");
  });
});

describe("pricingModelSchema / parsePricingModel", () => {
  it("accepts every kind including a nested hybrid", () => {
    const models: unknown[] = [
      { kind: "free" },
      { kind: "monthly", amountMinor: 2000, currency: "USD" },
      { kind: "annual", amountMinor: 1200, currency: "USD" },
      { kind: "payg", metric: "emails", unit: "email", ratePerUnit: 0.04, currency: "USD" },
      {
        kind: "tiered",
        metric: "video_minutes",
        mode: "graduated",
        tiers: [
          { upToUnits: 10, ratePerUnit: 5 },
          { upToUnits: null, ratePerUnit: 1 },
        ],
        currency: "USD",
      },
      {
        kind: "hybrid",
        components: [
          { kind: "monthly", amountMinor: 1000, currency: "USD" },
          { kind: "payg", metric: "emails", unit: "email", ratePerUnit: 2, currency: "USD" },
        ],
      },
    ];
    for (const m of models) {
      expect(pricingModelSchema.safeParse(m).success).toBe(true);
    }
  });

  it("upper-cases the currency", () => {
    const parsed = parsePricingModel({ kind: "monthly", amountMinor: 100, currency: "usd" });
    expect(parsed).toMatchObject({ currency: "USD" });
  });

  it("fail-soft returns null for malformed models", () => {
    expect(parsePricingModel({ kind: "nope" })).toBeNull();
    expect(parsePricingModel({ kind: "monthly", amountMinor: 100 })).toBeNull(); // no currency
    expect(parsePricingModel({ kind: "monthly", amountMinor: -5, currency: "USD" })).toBeNull();
    expect(
      parsePricingModel({
        kind: "payg",
        metric: "not_a_metric",
        unit: "x",
        ratePerUnit: 1,
        currency: "USD",
      }),
    ).toBeNull();
    expect(parsePricingModel(null)).toBeNull();
    expect(parsePricingModel("free")).toBeNull();
  });
});
