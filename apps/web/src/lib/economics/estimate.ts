// Financial Intelligence estimate layer (D-86, S3) — the Overview
// orchestrator. Pure-core + thin-fetch split, mirroring money-metrics.ts:
// `summarizeIntegrationCosts` / `rollupByCategory` / `rollupByIntegration` /
// `totalCostPence` are pure and unit-tested directly; `getEconomicsOverview`
// is the one place that fetches the registry, usage, assumptions, and reused
// revenue series and wires them together.
//
// Revenue is reused, not reinvented (D-86): MRR from getSubscriptionOverview
// (canonical-currency centavos, plus a per-currency map for any legacy
// subscriber still billing in a pre-D-99 currency). It used to add the latest
// month's withheld commission from `getCommissionSeries`; D-143 removed both
// the Transfer that commission was withheld from and the series itself, so
// subscription revenue is the whole of it now.

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import {
  estimateMonthlyCostMinor,
  INTEGRATION_CATEGORIES,
  PLATFORM_MONEY_CURRENCY,
  type IntegrationCategory,
  type PricingModel,
  type UsageValues,
} from "@spiralclass/shared";
import { getSubscriptionOverview } from "@/lib/subscriptions/admin-metrics";
import { getIntegrationRegistry } from "./registry";
import { getUsageForMonth } from "./usage";
import {
  getEconomicsAssumptions,
  toGbpPence,
  type EconomicsAssumptionsValues,
} from "./assumptions";

// --- Per-integration estimate (pure) ----------------------------------------

export type EstimateInput = {
  key: string;
  name: string;
  category: IntegrationCategory;
  currency: string;
  // null = the registry couldn't parse this row's pricing model (fail-soft).
  pricingModel: PricingModel | null;
};

export type IntegrationEstimate = {
  key: string;
  name: string;
  category: IntegrationCategory;
  currency: string;
  // Native-currency minor units, or null when the pricing model was
  // unparseable.
  nativeCostMinor: number | null;
  // GBP pence, or null when the pricing model was unparseable OR the
  // assumptions row has no FX rate for `currency` — either way this
  // integration is "unresolved" and excluded from the rollups below.
  gbpPence: number | null;
};

// Estimate every integration's monthly cost against one month's usage,
// converting to GBP. `unresolvedKeys` is every integration that couldn't be
// priced (bad pricing-model JSON or unknown currency) — the D-86 doc's "£0 +
// warning badge" surface, not silently dropped.
export function summarizeIntegrationCosts(
  integrations: EstimateInput[],
  usage: UsageValues,
  assumptions: EconomicsAssumptionsValues,
): { estimates: IntegrationEstimate[]; unresolvedKeys: string[] } {
  const estimates: IntegrationEstimate[] = [];
  const unresolvedKeys: string[] = [];

  for (const integration of integrations) {
    if (!integration.pricingModel) {
      estimates.push({
        key: integration.key,
        name: integration.name,
        category: integration.category,
        currency: integration.currency,
        nativeCostMinor: null,
        gbpPence: null,
      });
      unresolvedKeys.push(integration.key);
      continue;
    }
    const nativeCostMinor = estimateMonthlyCostMinor(integration.pricingModel, usage);
    const gbpPence = toGbpPence(nativeCostMinor, integration.currency, assumptions);
    if (gbpPence === null) unresolvedKeys.push(integration.key);
    estimates.push({
      key: integration.key,
      name: integration.name,
      category: integration.category,
      currency: integration.currency,
      nativeCostMinor,
      gbpPence,
    });
  }

  return { estimates, unresolvedKeys };
}

// --- Rollups (pure) ----------------------------------------------------------

function emptyCategoryTotals(): Record<IntegrationCategory, number> {
  return Object.fromEntries(INTEGRATION_CATEGORIES.map((c) => [c, 0])) as Record<
    IntegrationCategory,
    number
  >;
}

// GBP pence per category. Unresolved integrations (gbpPence === null)
// contribute 0 here — they're surfaced via unresolvedKeys instead, never
// silently folded into a category's total.
export function rollupByCategory(
  estimates: IntegrationEstimate[],
): Record<IntegrationCategory, number> {
  const totals = emptyCategoryTotals();
  for (const e of estimates) {
    if (e.gbpPence === null) continue;
    totals[e.category] += e.gbpPence;
  }
  return totals;
}

// GBP pence per integration key. Unresolved integrations are omitted (not
// zero-valued) so a "missing" key is distinguishable from a genuinely £0
// integration.
export function rollupByIntegration(estimates: IntegrationEstimate[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const e of estimates) {
    if (e.gbpPence === null) continue;
    totals[e.key] = e.gbpPence;
  }
  return totals;
}

// Total GBP pence across every resolved integration.
export function totalCostPence(estimates: IntegrationEstimate[]): number {
  return estimates.reduce((sum, e) => sum + (e.gbpPence ?? 0), 0);
}

type HighestIntegration = { key: string; name: string; gbpPence: number };

// The single costliest resolved integration, or null when none resolved.
export function highestCostIntegration(
  estimates: IntegrationEstimate[],
): HighestIntegration | null {
  let best: HighestIntegration | null = null;
  for (const e of estimates) {
    if (e.gbpPence === null) continue;
    if (!best || e.gbpPence > best.gbpPence)
      best = { key: e.key, name: e.name, gbpPence: e.gbpPence };
  }
  return best;
}

type HighestCategory = { category: IntegrationCategory; gbpPence: number };

// The single costliest category by rolled-up total, or null when every
// total is 0 (nothing resolved / nothing costs anything).
export function highestCostCategory(
  byCategory: Record<IntegrationCategory, number>,
): HighestCategory | null {
  let best: HighestCategory | null = null;
  for (const category of INTEGRATION_CATEGORIES) {
    const gbpPence = byCategory[category];
    if (gbpPence <= 0) continue;
    if (!best || gbpPence > best.gbpPence) best = { category, gbpPence };
  }
  return best;
}

// --- KPI math (pure) ---------------------------------------------------------

// Gross margin as a 0–1 fraction, or null when there's no revenue to divide
// by (avoids a divide-by-zero reading as "0% margin", which would imply
// break-even rather than "not yet meaningful").
export function grossMarginFraction(revenuePence: number, profitPence: number): number | null {
  if (revenuePence <= 0) return null;
  return profitPence / revenuePence;
}

// Cost divided evenly across `count` (active teachers, lessons), or null
// when `count` is 0 — a per-unit cost is meaningless with no units.
export function costPerUnit(totalPence: number, count: number): number | null {
  if (count <= 0) return null;
  return Math.round(totalPence / count);
}

// --- Orchestrator (fetch) ----------------------------------------------------

export type EconomicsOverview = {
  fxAsOf: Date;
  integrations: IntegrationEstimate[];
  byCategory: Record<IntegrationCategory, number>;
  byIntegration: Record<string, number>;
  totalCostPence: number;
  unresolvedIntegrationKeys: string[];
  estMonthlyRevenuePence: number;
  grossProfitPence: number;
  grossMarginFraction: number | null;
  costPerActiveTeacherPence: number | null;
  costPerLessonPence: number | null;
  highestCostIntegration: HighestIntegration | null;
  highestCostCategory: HighestCategory | null;
};

type Db = PrismaClient | Prisma.TransactionClient;

// The full /admin/economics Overview panel's data, in one Promise.all fetch
// (S4's page.tsx calls this once). `now` selects both the usage month and
// the revenue snapshot, so every number on the panel describes the same
// month.
export async function getEconomicsOverview(
  now: Date = new Date(),
  db: Db = defaultPrisma,
): Promise<EconomicsOverview> {
  const [registry, usage, assumptions, subscriptionOverview, activeTeacherCount] =
    await Promise.all([
      getIntegrationRegistry(db),
      getUsageForMonth(now, db),
      getEconomicsAssumptions(db),
      getSubscriptionOverview(now),
      db.teacher.count({ where: { onboardingCompleteAt: { not: null } } }),
    ]);

  const { estimates, unresolvedKeys } = summarizeIntegrationCosts(registry, usage, assumptions);
  const byCategory = rollupByCategory(estimates);
  const byIntegration = rollupByIntegration(estimates);
  const totalPence = totalCostPence(estimates);

  // MRR, converted to GBP pence per-currency and summed — never assume every
  // subscriber bills in one currency. The canonical bucket (GBP as of D-99)
  // converts at rate 1; a legacy pre-D-99 subscriber still on their old
  // currency converts through its own FX assumption instead of being dropped
  // or (worse) blended in as if it were already GBP.
  const mrrOtherCurrencyPence = Object.entries(
    subscriptionOverview.mrrOtherCurrencyMinorUnits,
  ).reduce((sum, [currency, cents]) => sum + (toGbpPence(cents, currency, assumptions) ?? 0), 0);
  const mrrPence =
    (toGbpPence(subscriptionOverview.mrrMinorUnits, PLATFORM_MONEY_CURRENCY, assumptions) ?? 0) +
    mrrOtherCurrencyPence;
  // Subscriptions are the whole revenue line since D-143 — no marketplace
  // commission is withheld any more, so there is nothing else to convert in.
  const estMonthlyRevenuePence = mrrPence;
  const grossProfitPence = estMonthlyRevenuePence - totalPence;

  const lessons = usage.lessons ?? 0;

  return {
    fxAsOf: assumptions.fxAsOf,
    integrations: estimates,
    byCategory,
    byIntegration,
    totalCostPence: totalPence,
    unresolvedIntegrationKeys: unresolvedKeys,
    estMonthlyRevenuePence,
    grossProfitPence,
    grossMarginFraction: grossMarginFraction(estMonthlyRevenuePence, grossProfitPence),
    costPerActiveTeacherPence: costPerUnit(totalPence, activeTeacherCount),
    costPerLessonPence: costPerUnit(totalPence, lessons),
    highestCostIntegration: highestCostIntegration(estimates),
    highestCostCategory: highestCostCategory(byCategory),
  };
}
