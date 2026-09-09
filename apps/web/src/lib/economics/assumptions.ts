// Financial Intelligence estimate layer (D-86, S3) — the FX + allocation
// assumptions the estimate layer's cost math is built on. Pure-core +
// thin-fetch split, mirroring money-metrics.ts: `toGbpPence` (below) is a
// pure function with no DB dependency; `getEconomicsAssumptions` is the one
// place that reads the singleton row.
//
// Manually maintained — this app has no live FX feed (D-86 risk note) — so
// every conversion is only as fresh as the last time an admin edited the
// assumptions row via the S4 UI.

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { currencyExponent } from "@spiralclass/shared";

type Db = PrismaClient | Prisma.TransactionClient;

export type AllocationBasis = "active_teachers" | "lessons" | "even";

export type EconomicsAssumptionsValues = {
  fxUsdToGbp: number;
  fxMxnToGbp: number;
  fxEurToGbp: number;
  allocationBasis: AllocationBasis;
  fxAsOf: Date;
};

// FX rates (major-unit to major-unit, e.g. 1 USD → this many GBP) used until an
// admin sets fresher ones via the S4 UI — see `EconomicsAssumptions` in
// schema.prisma. Refreshed 2026-07-15 from live mid-market rates; still not
// treated as live — `fxAsOf` surfaces the staleness in the UI.
const DEFAULT_ASSUMPTIONS: EconomicsAssumptionsValues = {
  fxUsdToGbp: 0.7387,
  fxMxnToGbp: 0.04249,
  fxEurToGbp: 0.846,
  allocationBasis: "active_teachers",
  fxAsOf: new Date("2026-07-15T00:00:00.000Z"),
};

function isAllocationBasis(value: string): value is AllocationBasis {
  return value === "active_teachers" || value === "lessons" || value === "even";
}

// The singleton EconomicsAssumptions row (id="default"), falling back to
// DEFAULT_ASSUMPTIONS when it hasn't been created yet — mirrors
// getFoundingCohortState's read-with-fallback pattern rather than an
// upsert-on-read, since the S4 action layer owns writes.
export async function getEconomicsAssumptions(
  db: Db = defaultPrisma,
): Promise<EconomicsAssumptionsValues> {
  const row = await db.economicsAssumptions.findUnique({ where: { id: "default" } });
  if (!row) return DEFAULT_ASSUMPTIONS;
  return {
    fxUsdToGbp: row.fxUsdToGbp,
    fxMxnToGbp: row.fxMxnToGbp,
    fxEurToGbp: row.fxEurToGbp,
    allocationBasis: isAllocationBasis(row.allocationBasis)
      ? row.allocationBasis
      : DEFAULT_ASSUMPTIONS.allocationBasis,
    fxAsOf: row.fxAsOf,
  };
}

// The major-unit-to-GBP rate for a native billing currency, or null when the
// assumptions row has no rate for it (surfaced separately per the D-86 risk
// note — "surface unknown-currency integrations separately" — rather than
// guessed).
export function fxRateToGbp(
  currency: string,
  assumptions: EconomicsAssumptionsValues,
): number | null {
  switch (currency.toUpperCase()) {
    case "GBP":
      return 1;
    case "USD":
      return assumptions.fxUsdToGbp;
    case "MXN":
      return assumptions.fxMxnToGbp;
    case "EUR":
      return assumptions.fxEurToGbp;
    default:
      return null;
  }
}

// Convert an integer minor-unit amount in `currency` into integer GBP pence,
// or null when `currency` has no known FX rate. Pure — the engine
// (economics-pricing.ts) stays currency-agnostic and this is the one place
// that injects FX, exactly as the D-86 doc specifies.
export function toGbpPence(
  minorUnits: number,
  currency: string,
  assumptions: EconomicsAssumptionsValues,
): number | null {
  const rate = fxRateToGbp(currency, assumptions);
  if (rate === null) return null;
  const majorNative = minorUnits / 10 ** currencyExponent(currency);
  return Math.round(majorNative * rate * 100);
}
