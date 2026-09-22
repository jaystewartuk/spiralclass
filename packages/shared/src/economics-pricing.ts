// SpiralClass — Financial Intelligence pricing engine (D-86).
//
// A generic, provider-agnostic model of what a third-party integration costs
// per month, evaluated against usage meters. There is deliberately NO
// per-provider branching anywhere in this file: a provider's specifics live in
// DATA (an `Integration.pricingModel` JSON column, validated by
// `pricingModelSchema` below), never in code. Adding an integration is a data
// change, not a code change.
//
// The engine is CURRENCY-PURE — every function returns an amount in the
// pricing model's own native minor units (USD cents, MXN centavos, GBP pence,
// …). Converting to the dashboard's display currency (GBP, per D-58) is a
// separate concern handled by the app-side lib layer, exactly as
// `money-metrics.ts` refuses to blend currencies itself. This keeps the whole
// engine trivially unit-testable with no FX or clock dependency.
//
// Money convention mirrors the rest of the app: integer minor units. Unit
// RATES (`ratePerUnit`) are the one exception — real per-unit prices are
// sub-penny (a token, an email), so rates are floats and each integration's
// total is rounded back to an integer at the boundary.

import { z } from "zod";
import { USAGE_METRICS, type UsageMetric } from "./economics-config";

// --- Types -----------------------------------------------------------------

// A free-tier allowance expressed against one usage metric (e.g. 3,000
// emails/month, 1 GB storage). Whether the allowance is a monthly flow or a
// stock level is the metric's own nature — the engine treats `value` uniformly
// (see estimateExhaustionMonth).
export type FreeTier = { metric: UsageMetric; allowance: number };

// Fields every pricing model may carry. `schemaVersion` lets a future shape
// change be migrated on read; `freeTier` is an explicit allowance for models
// whose shape doesn't already imply one (a flat `monthly` plan with a bundled
// quota, say).
type PricingBase = { schemaVersion?: number; freeTier?: FreeTier };

// One graduated/volume band. `upToUnits` is the cumulative upper bound of the
// band (null = unbounded final band); `ratePerUnit` is native minor units per
// unit of the metric.
export type PricingTier = { upToUnits: number | null; ratePerUnit: number };

export type PricingModel =
  | ({ kind: "free" } & PricingBase)
  | ({ kind: "monthly"; amountMinor: number; currency: string } & PricingBase)
  | ({ kind: "annual"; amountMinor: number; currency: string } & PricingBase)
  | ({
      kind: "payg";
      metric: UsageMetric;
      unit: string;
      ratePerUnit: number;
      includedUnits?: number;
      currency: string;
    } & PricingBase)
  | ({
      kind: "tiered";
      metric: UsageMetric;
      mode: "graduated" | "volume";
      tiers: PricingTier[];
      includedUnits?: number;
      currency: string;
    } & PricingBase)
  | ({ kind: "hybrid"; components: PricingModel[] } & PricingBase);

export type PricingKind = PricingModel["kind"];
export const PRICING_KINDS = [
  "free",
  "monthly",
  "annual",
  "payg",
  "tiered",
  "hybrid",
] as const satisfies readonly PricingKind[];

// Measured usage for a single month, keyed by metric. Missing metric → 0.
export type UsageValues = Partial<Record<UsageMetric, number>>;

// --- Zod schema (validated at the DB read boundary) ------------------------

const usageMetricSchema = z.enum(USAGE_METRICS);
// ISO-4217-ish: three ASCII letters, upper-cased. Kept loose on purpose — the
// FX layer decides which currencies it can actually convert.
const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/u);
const freeTierSchema = z.object({
  metric: usageMetricSchema,
  allowance: z.number().nonnegative(),
});
const baseShape = {
  schemaVersion: z.number().int().positive().optional(),
  freeTier: freeTierSchema.optional(),
};
const tierSchema = z.object({
  upToUnits: z.number().nonnegative().nullable(),
  ratePerUnit: z.number().nonnegative(),
});

const freeModel = z.object({ kind: z.literal("free"), ...baseShape });
const monthlyModel = z.object({
  kind: z.literal("monthly"),
  amountMinor: z.number().int().nonnegative(),
  currency: currencySchema,
  ...baseShape,
});
const annualModel = z.object({
  kind: z.literal("annual"),
  amountMinor: z.number().int().nonnegative(),
  currency: currencySchema,
  ...baseShape,
});
const paygModel = z.object({
  kind: z.literal("payg"),
  metric: usageMetricSchema,
  unit: z.string().min(1),
  ratePerUnit: z.number().nonnegative(),
  includedUnits: z.number().nonnegative().optional(),
  currency: currencySchema,
  ...baseShape,
});
const tieredModel = z.object({
  kind: z.literal("tiered"),
  metric: usageMetricSchema,
  mode: z.enum(["graduated", "volume"]),
  tiers: z.array(tierSchema).min(1),
  includedUnits: z.number().nonnegative().optional(),
  currency: currencySchema,
  ...baseShape,
});
// Only `hybrid` is recursive; z.lazy defers the self-reference until
// `pricingModelSchema` is initialized below.
const hybridModel = z.object({
  kind: z.literal("hybrid"),
  components: z.lazy(() => z.array(pricingModelSchema).min(1)),
  ...baseShape,
});

// The cast bridges the recursive z.lazy field to the hand-written PricingModel
// union (Zod can't infer through the lazy self-reference). Runtime validation
// is exact; only the static type is asserted.
export const pricingModelSchema = z.discriminatedUnion("kind", [
  freeModel,
  monthlyModel,
  annualModel,
  paygModel,
  tieredModel,
  hybridModel,
]) as unknown as z.ZodType<PricingModel>;

// Fail-soft parse for the DB read boundary: an unparseable model returns null
// so a single bad row degrades to £0 + a warning badge rather than 500-ing the
// whole dashboard (D-86 risk note).
export function parsePricingModel(value: unknown): PricingModel | null {
  const result = pricingModelSchema.safeParse(value);
  return result.success ? result.data : null;
}

// --- Cost estimation (pure, native minor units) ----------------------------

// Estimated monthly cost of one pricing model at the given usage, in the
// model's native currency minor units. Rounded to an integer at the boundary
// (rates are sub-unit floats). Hybrid sums its already-rounded components.
export function estimateMonthlyCostMinor(model: PricingModel, usage: UsageValues): number {
  switch (model.kind) {
    case "free":
      return 0;
    case "monthly":
      return model.amountMinor;
    case "annual":
      // Amortize the annual fee across 12 months for a per-month view.
      return Math.round(model.amountMinor / 12);
    case "payg": {
      const billable = billableUnits(usage[model.metric] ?? 0, model.includedUnits);
      return Math.round(billable * model.ratePerUnit);
    }
    case "tiered":
      return Math.round(tieredCost(model, usage));
    case "hybrid":
      return model.components.reduce((sum, c) => sum + estimateMonthlyCostMinor(c, usage), 0);
  }
}

// Units above the bundled allowance, floored at 0.
function billableUnits(used: number, includedUnits?: number): number {
  return Math.max(0, used - (includedUnits ?? 0));
}

function tieredCost(model: Extract<PricingModel, { kind: "tiered" }>, usage: UsageValues): number {
  const billable = billableUnits(usage[model.metric] ?? 0, model.includedUnits);
  if (billable <= 0) return 0;
  const lastRate = model.tiers[model.tiers.length - 1].ratePerUnit;

  if (model.mode === "volume") {
    // Every unit priced at the single band the total lands in.
    const band =
      model.tiers.find((t) => t.upToUnits === null || billable <= t.upToUnits) ??
      model.tiers[model.tiers.length - 1];
    return billable * band.ratePerUnit;
  }

  // Graduated: each band's slice priced at that band's rate.
  let remaining = billable;
  let prevCap = 0;
  let cost = 0;
  for (const tier of model.tiers) {
    if (remaining <= 0) break;
    const cap = tier.upToUnits === null ? Infinity : tier.upToUnits;
    const bandSize = Math.min(remaining, Math.max(0, cap - prevCap));
    cost += bandSize * tier.ratePerUnit;
    remaining -= bandSize;
    prevCap = cap;
  }
  // Usage beyond a finite final band spills over at the last band's rate.
  if (remaining > 0) cost += remaining * lastRate;
  return cost;
}

// --- Free-tier status ------------------------------------------------------

export type FreeTierStatus = {
  metric: UsageMetric;
  allowance: number;
  used: number;
  remaining: number;
  exhausted: boolean;
};

// The allowance a model implies: an explicit top-level `freeTier` wins;
// otherwise a payg/tiered model's `includedUnits` IS a free allowance on its
// metric; a hybrid resolves to the first component that yields one. Everything
// else (a flat paid `monthly` with no bundled quota) has none.
export function resolveFreeTier(model: PricingModel): FreeTier | null {
  if (model.freeTier) return model.freeTier;
  switch (model.kind) {
    case "payg":
    case "tiered":
      return model.includedUnits && model.includedUnits > 0
        ? { metric: model.metric, allowance: model.includedUnits }
        : null;
    case "hybrid":
      for (const c of model.components) {
        const ft = resolveFreeTier(c);
        if (ft) return ft;
      }
      return null;
    default:
      return null;
  }
}

export function freeTierStatus(model: PricingModel, usage: UsageValues): FreeTierStatus | null {
  const ft = resolveFreeTier(model);
  if (!ft) return null;
  const used = usage[ft.metric] ?? 0;
  return {
    metric: ft.metric,
    allowance: ft.allowance,
    used,
    remaining: Math.max(0, ft.allowance - used),
    exhausted: used >= ft.allowance,
  };
}

// --- Free-tier exhaustion forecast -----------------------------------------

export type UsagePoint = { month: string; value: number };

// The `YYYY-MM` month in which the metric's value is projected to reach the
// free-tier allowance, based on the trailing run-rate; null when the model has
// no free tier, there's too little history to project, or usage is flat/
// declining (never exhausts). Already at/over the allowance → the latest month.
//
// `value` is compared to the allowance directly, so this is correct for both a
// monthly-flow allowance (emails/month, tokens/month — value is that month's
// flow) and a stock allowance (storage GB — value is the running level).
export function estimateExhaustionMonth(model: PricingModel, history: UsagePoint[]): string | null {
  const ft = resolveFreeTier(model);
  if (!ft) return null;

  const sorted = [...history].sort((a, b) => a.month.localeCompare(b.month));
  if (sorted.length === 0) return null;

  const latest = sorted[sorted.length - 1];
  if (latest.value >= ft.allowance) return latest.month;
  if (sorted.length < 2) return null; // can't infer a trend from one point

  // Average month-over-month change across the window.
  const first = sorted[0];
  const growthPerMonth = (latest.value - first.value) / (sorted.length - 1);
  if (growthPerMonth <= 0) return null; // flat or shrinking → never exhausts

  const monthsOut = Math.ceil((ft.allowance - latest.value) / growthPerMonth);
  return addMonths(latest.month, monthsOut);
}

// "YYYY-MM" + n calendar months (UTC-safe, handles year rollover). Pure; the
// shared package can't import money-metrics.ts's month helpers (app-side), so
// this is the local equivalent.
export function addMonths(monthKey: string, n: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}
