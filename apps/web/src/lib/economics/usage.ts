// Financial Intelligence estimate layer (D-86, S3) — the UsageInput read
// side, feeding the pricing engine's `UsageValues` (a single month's
// snapshot) and `UsagePoint[]` (a metric's history, for exhaustion
// projection). Reuses `monthKey`/`monthWindowStart` from money-metrics.ts per
// the D-86 doc, so month bucketing can't drift between the actuals and
// estimate surfaces.

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { monthKey, monthWindowStart } from "@/lib/money-metrics";
import {
  isUsageMetric,
  type UsageMetric,
  type UsageValues,
  type UsagePoint,
} from "@spiralclass/shared";

type Db = PrismaClient | Prisma.TransactionClient;

// Every metric reading for the calendar month containing `now`, keyed by
// metric. A metric with no row that month is simply absent (the pricing
// engine treats a missing key as 0 usage). Rows with an unrecognized `metric`
// value are dropped rather than surfaced — fail-soft, same posture as
// registry.ts's pricing-model parse.
export async function getUsageForMonth(
  now: Date = new Date(),
  db: Db = defaultPrisma,
): Promise<UsageValues> {
  const rows = await db.usageInput.findMany({
    where: { periodMonth: monthWindowStart(now, 1) },
    select: { metric: true, value: true },
  });
  const usage: UsageValues = {};
  for (const row of rows) {
    if (!isUsageMetric(row.metric)) continue;
    usage[row.metric] = row.value;
  }
  return usage;
}

// One metric's monthly readings over the trailing `monthsBack` window,
// oldest first — the shape estimateExhaustionMonth (economics-pricing.ts)
// projects a run-rate against. Months with no row are simply absent (not
// zero-filled): the exhaustion projection only needs the months that were
// actually entered, unlike a chart series.
export async function getUsageHistory(
  metric: UsageMetric,
  monthsBack: number,
  now: Date = new Date(),
  db: Db = defaultPrisma,
): Promise<UsagePoint[]> {
  const rows = await db.usageInput.findMany({
    where: { metric, periodMonth: { gte: monthWindowStart(now, monthsBack) } },
    select: { periodMonth: true, value: true },
    orderBy: { periodMonth: "asc" },
  });
  return rows.map((row) => ({ month: monthKey(row.periodMonth), value: row.value }));
}
