import { cache } from "react";
import { currencyExponent } from "@spiralclass/shared";
import {
  fxRateToGbp,
  getEconomicsAssumptions,
  type EconomicsAssumptionsValues,
} from "@/lib/economics/assumptions";

// A SECOND, approximate price in USD, shown beside the teacher's own currency
// on the public funnel.
//
// The problem it solves is one number: `MX$6,000` tells a buyer in Chicago
// nothing at all, and they have to decide whether to keep reading before they
// can find out. `≈ US$345` under it is the whole fix. The charge does not
// change — the teacher's currency is still what settles (D-64, and under D-143
// her Stripe account settles in her own country), so this is presentation and
// nothing else.
//
// It reuses the EXISTING FX source rather than introducing one. `money-metrics.ts`
// says in two places that this app has no FX-rate source, and that is still
// true in the sense it means — nothing here calls a rates API. What does exist
// is `EconomicsAssumptions`: a singleton row an admin maintains through the S4
// UI, carrying `fxAsOf` precisely so staleness is visible rather than assumed.
// Deriving the buyer-facing figure from that is the difference between an
// operator-owned number and one invented in code.
//
// Two consequences of that reuse, named rather than discovered later:
//
//   * It couples a PUBLIC price hint to an INTERNAL accounting input. An admin
//     who sets a deliberately conservative rate for the P&L moves what buyers
//     see. That is acceptable while both want the same thing — a fair
//     mid-market number — and is the reason this returns `asOf` so the caller
//     can say "approximate" rather than quoting it as a price.
//   * A stale rate is worse than no rate on a page someone is buying from, so
//     this refuses to answer past MAX_AGE_DAYS instead of degrading quietly.
//     The default assumptions row is dated in code; if nobody has refreshed it
//     the hint simply stops rendering.

// Past this, the figure is not shown at all. Chosen against the alternative of
// widening the "approximate" wording: a buyer who converts a stale number and
// finds the real charge meaningfully different has been misled, and no adverb
// in front of it repairs that.
export const APPROX_MAX_AGE_DAYS = 60;

export type ApproxUsd = {
  // Integer US cents, rounded to whole dollars — this is an orientation
  // figure, and cents on an approximation imply a precision it does not have.
  centsUsd: number;
  asOf: Date;
};

// Pure core, so the rounding and the staleness rule are testable without a DB.
export function approxUsdFrom(
  minorUnits: number,
  currency: string,
  assumptions: EconomicsAssumptionsValues,
  now: Date,
): ApproxUsd | null {
  const code = currency.toUpperCase();
  // Nothing to add for a teacher already priced in dollars.
  if (code === "USD") return null;

  const ageDays = (now.getTime() - assumptions.fxAsOf.getTime()) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays > APPROX_MAX_AGE_DAYS || ageDays < 0) return null;

  // Both legs go through GBP because that is the only pivot the assumptions row
  // stores. A currency it has no rate for returns null rather than a guess —
  // the same posture `fxRateToGbp` already takes for the P&L.
  const toGbp = fxRateToGbp(code, assumptions);
  if (toGbp === null || assumptions.fxUsdToGbp <= 0) return null;

  const major = minorUnits / 10 ** currencyExponent(code);
  const usdMajor = (major * toGbp) / assumptions.fxUsdToGbp;
  if (!Number.isFinite(usdMajor) || usdMajor <= 0) return null;

  return { centsUsd: Math.round(usdMajor) * 100, asOf: assumptions.fxAsOf };
}

// Request-scoped so a page rendering several package rows reads the singleton
// once. The booking landing is the hottest page in the product and already
// dedupes its teacher load for exactly this reason.
export const approxUsdAssumptions = cache(async (): Promise<EconomicsAssumptionsValues> =>
  getEconomicsAssumptions(),
);
