// Cross-page dashboard series for the admin Overview — deliberately separate
// from money-metrics.ts, which stays scoped to money (MRR/GMV/deferred
// revenue). Reuses money-metrics.ts's month-bucketing helpers rather than
// redefining them so the two can't drift on boundary rules.

import { prisma } from "@/lib/prisma";
import { monthKey, monthLabel, monthWindowStart, recentMonths } from "@/lib/money-metrics";

export type SignupPoint = { month: string; label: string; count: number };

// Pure: bucket teacher-creation timestamps into the given months, zero-filled
// and in order. Dates outside the window are ignored (the query already
// bounds them, but the guard keeps this safe to reuse on any input).
export function summarizeSignupSeries(createdAts: Date[], months: string[]): SignupPoint[] {
  const byMonth = new Map<string, number>(months.map((month) => [month, 0]));
  for (const createdAt of createdAts) {
    const key = monthKey(createdAt);
    const current = byMonth.get(key);
    if (current !== undefined) byMonth.set(key, current + 1);
  }
  return months.map((month) => ({
    month,
    label: monthLabel(month),
    count: byMonth.get(month) ?? 0,
  }));
}

export async function getTeacherSignupSeries(
  monthsBack = 6,
  now: Date = new Date(),
): Promise<SignupPoint[]> {
  const months = recentMonths(now, monthsBack);
  const teachers = await prisma.teacher.findMany({
    where: { createdAt: { gte: monthWindowStart(now, monthsBack) } },
    select: { createdAt: true },
  });
  return summarizeSignupSeries(
    teachers.map((t) => t.createdAt),
    months,
  );
}
