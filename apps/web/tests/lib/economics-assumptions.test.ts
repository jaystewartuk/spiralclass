import { describe, expect, it } from "vitest";
import {
  fxRateToGbp,
  toGbpPence,
  getEconomicsAssumptions,
  type EconomicsAssumptionsValues,
} from "@/lib/economics/assumptions";

// D-86 S3 — the FX conversion layer. `fxRateToGbp`/`toGbpPence` are pure;
// `getEconomicsAssumptions` is the one DB read, exercised here against a fake
// Prisma client (mirrors tests/lib/economics-seed-registry.test.ts's
// fakePrisma pattern) rather than a real DB.

const ASSUMPTIONS: EconomicsAssumptionsValues = {
  fxUsdToGbp: 0.8,
  fxMxnToGbp: 0.05,
  fxEurToGbp: 0.9,
  allocationBasis: "active_teachers",
  fxAsOf: new Date("2026-07-01T00:00:00.000Z"),
};

describe("fxRateToGbp", () => {
  it("resolves the assumptions row's rate for each known currency", () => {
    expect(fxRateToGbp("USD", ASSUMPTIONS)).toBe(0.8);
    expect(fxRateToGbp("MXN", ASSUMPTIONS)).toBe(0.05);
    expect(fxRateToGbp("EUR", ASSUMPTIONS)).toBe(0.9);
  });

  it("GBP is always 1, independent of the assumptions row", () => {
    expect(fxRateToGbp("GBP", ASSUMPTIONS)).toBe(1);
  });

  it("is case-insensitive on the currency code", () => {
    expect(fxRateToGbp("usd", ASSUMPTIONS)).toBe(0.8);
  });

  it("returns null for a currency with no configured rate", () => {
    expect(fxRateToGbp("JPY", ASSUMPTIONS)).toBeNull();
  });
});

describe("toGbpPence", () => {
  it("converts USD cents to GBP pence using the assumptions rate", () => {
    // $10.00 (1000 cents) * 0.8 = £8.00 = 800 pence.
    expect(toGbpPence(1000, "USD", ASSUMPTIONS)).toBe(800);
  });

  it("converts MXN centavos to GBP pence", () => {
    // $200.00 MXN (20000 centavos) * 0.05 = £10.00 = 1000 pence.
    expect(toGbpPence(20_000, "MXN", ASSUMPTIONS)).toBe(1000);
  });

  it("GBP pence pass through unchanged (identity conversion)", () => {
    expect(toGbpPence(1234, "GBP", ASSUMPTIONS)).toBe(1234);
  });

  it("converts EUR cents to GBP pence", () => {
    // €100.00 (10000 cents) * 0.9 = £90.00 = 9000 pence.
    expect(toGbpPence(10_000, "EUR", ASSUMPTIONS)).toBe(9000);
  });

  it("returns null for an unsupported currency rather than guessing", () => {
    expect(toGbpPence(1000, "JPY", ASSUMPTIONS)).toBeNull();
  });

  it("rounds to the nearest whole pence", () => {
    // $0.03 USD (3 cents) * 0.8 = 0.024 GBP = 2.4p → rounds to 2.
    expect(toGbpPence(3, "USD", ASSUMPTIONS)).toBe(2);
  });
});

function fakePrisma(row: any = null) {
  return {
    economicsAssumptions: {
      findUnique: async () => row,
    },
  } as any;
}

describe("getEconomicsAssumptions", () => {
  it("falls back to defaults when the singleton row doesn't exist yet", async () => {
    const result = await getEconomicsAssumptions(fakePrisma(null));
    expect(result.allocationBasis).toBe("active_teachers");
    expect(result.fxUsdToGbp).toBeGreaterThan(0);
    expect(result.fxMxnToGbp).toBeGreaterThan(0);
    expect(result.fxEurToGbp).toBeGreaterThan(0);
  });

  it("maps a stored row's fields through untouched", async () => {
    const row = {
      fxUsdToGbp: 0.77,
      fxMxnToGbp: 0.044,
      fxEurToGbp: 0.85,
      allocationBasis: "lessons",
      fxAsOf: new Date("2026-06-15T00:00:00.000Z"),
    };
    const result = await getEconomicsAssumptions(fakePrisma(row));
    expect(result).toEqual(row);
  });

  it("falls back to the default allocation basis for an invalid stored value", async () => {
    const row = {
      fxUsdToGbp: 0.77,
      fxMxnToGbp: 0.044,
      fxEurToGbp: 0.85,
      allocationBasis: "not_a_real_basis",
      fxAsOf: new Date("2026-06-15T00:00:00.000Z"),
    };
    const result = await getEconomicsAssumptions(fakePrisma(row));
    expect(result.allocationBasis).toBe("active_teachers");
  });
});
