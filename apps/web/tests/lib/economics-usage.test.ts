import { describe, expect, it } from "vitest";
import { getUsageForMonth, getUsageHistory } from "@/lib/economics/usage";

// D-86 S3 — the UsageInput read side. Exercised against a fake Prisma client
// (mirrors economics-seed-registry.test.ts's fakePrisma pattern) rather than
// a real DB. NOW is mid-month so nothing accidentally lands on a boundary,
// matching money-metrics.test.ts's convention.
const NOW = new Date("2026-07-15T12:00:00.000Z");

function fakePrisma(rows: any[]) {
  return {
    usageInput: {
      findMany: async ({ where }: any) => {
        if (where.periodMonth instanceof Date) {
          return rows.filter((r) => r.periodMonth.getTime() === where.periodMonth.getTime());
        }
        // getUsageHistory: { metric, periodMonth: { gte } }.
        return rows
          .filter(
            (r) =>
              r.metric === where.metric &&
              r.periodMonth.getTime() >= where.periodMonth.gte.getTime(),
          )
          .sort((a, b) => a.periodMonth.getTime() - b.periodMonth.getTime());
      },
    },
  } as any;
}

function usageRow(over: any = {}) {
  return {
    metric: "lessons",
    periodMonth: new Date("2026-07-01T00:00:00.000Z"),
    value: 120,
    ...over,
  };
}

describe("getUsageForMonth", () => {
  it("keys every reading for the month by metric", async () => {
    const rows = [
      usageRow({ metric: "lessons", value: 120 }),
      usageRow({ metric: "ai_generations", value: 45 }),
    ];
    const usage = await getUsageForMonth(NOW, fakePrisma(rows));
    expect(usage).toEqual({ lessons: 120, ai_generations: 45 });
  });

  it("drops rows with an unrecognized metric (fail-soft)", async () => {
    const rows = [usageRow({ metric: "not_a_real_metric", value: 1 })];
    const usage = await getUsageForMonth(NOW, fakePrisma(rows));
    expect(usage).toEqual({});
  });

  it("returns an empty object when nothing was entered that month", async () => {
    const usage = await getUsageForMonth(NOW, fakePrisma([]));
    expect(usage).toEqual({});
  });
});

describe("getUsageHistory", () => {
  it("returns one metric's readings in the window, oldest first", async () => {
    const rows = [
      usageRow({
        metric: "storage_gb",
        periodMonth: new Date("2026-06-01T00:00:00.000Z"),
        value: 5,
      }),
      usageRow({
        metric: "storage_gb",
        periodMonth: new Date("2026-05-01T00:00:00.000Z"),
        value: 3,
      }),
      usageRow({
        metric: "storage_gb",
        periodMonth: new Date("2026-07-01T00:00:00.000Z"),
        value: 8,
      }),
    ];
    const history = await getUsageHistory("storage_gb", 3, NOW, fakePrisma(rows));
    expect(history).toEqual([
      { month: "2026-05", value: 3 },
      { month: "2026-06", value: 5 },
      { month: "2026-07", value: 8 },
    ]);
  });

  it("excludes other metrics and months outside the window", async () => {
    const rows = [
      usageRow({ metric: "emails", periodMonth: new Date("2026-07-01T00:00:00.000Z"), value: 999 }),
      usageRow({
        metric: "storage_gb",
        periodMonth: new Date("2026-01-01T00:00:00.000Z"),
        value: 1,
      }),
    ];
    const history = await getUsageHistory("storage_gb", 3, NOW, fakePrisma(rows));
    expect(history).toEqual([]);
  });

  it("is simply absent for months with no row (not zero-filled)", async () => {
    const rows = [
      usageRow({
        metric: "storage_gb",
        periodMonth: new Date("2026-07-01T00:00:00.000Z"),
        value: 8,
      }),
    ];
    const history = await getUsageHistory("storage_gb", 3, NOW, fakePrisma(rows));
    expect(history).toEqual([{ month: "2026-07", value: 8 }]);
  });
});
