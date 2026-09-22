import { describe, expect, it } from "vitest";
import {
  monthKey,
  recentMonths,
  monthWindowStart,
  monthLabel,
  summarizeRevenueSeries,
  otherCurrencyRevenueTotals,
  summarizeGmvSeries,
  summarizeExpenseSeries,
  otherCurrencyExpenseTotals,
  summarizeNetProfitSeries,
  type PaidInvoice,
  type PaidPayment,
  type PlatformExpenseRow,
  type RevenuePoint,
  type ExpensePoint,
} from "@/lib/money-metrics";

// Mid-month so nothing accidentally lands on a boundary.
const NOW = new Date("2026-07-15T12:00:00.000Z");

describe("month bucketing helpers", () => {
  it("monthKey is UTC calendar month", () => {
    expect(monthKey(new Date("2026-07-01T00:00:00.000Z"))).toBe("2026-07");
    expect(monthKey(new Date("2026-07-31T23:59:59.000Z"))).toBe("2026-07");
    expect(monthKey(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01");
  });

  it("recentMonths returns `count` months, oldest first, ending on now's month", () => {
    expect(recentMonths(NOW, 6)).toEqual([
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
    ]);
  });

  it("recentMonths crosses a year boundary correctly", () => {
    expect(recentMonths(new Date("2026-01-10T00:00:00.000Z"), 3)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
    ]);
  });

  it("monthWindowStart is the first instant of the oldest bucket", () => {
    expect(monthWindowStart(NOW, 6).toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(monthWindowStart(NOW, 1).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("monthLabel is a short, locale-free label", () => {
    expect(monthLabel("2026-07")).toBe("Jul '26");
    expect(monthLabel("2025-12")).toBe("Dec '25");
  });
});

describe("summarizeRevenueSeries", () => {
  const months = recentMonths(NOW, 3); // 2026-05, 2026-06, 2026-07

  function inv(over: Partial<PaidInvoice> = {}): PaidInvoice {
    return {
      paidAt: new Date("2026-07-10T00:00:00.000Z"),
      amountMinorUnits: 799,
      feeMinorUnits: 40,
      netMinorUnits: 759,
      currency: "GBP",
      ...over,
    };
  }

  it("zero-fills every month in the window", () => {
    const s = summarizeRevenueSeries([], months);
    expect(s).toEqual([
      { month: "2026-05", grossMinorUnits: 0, feeMinorUnits: 0, netMinorUnits: 0 },
      { month: "2026-06", grossMinorUnits: 0, feeMinorUnits: 0, netMinorUnits: 0 },
      { month: "2026-07", grossMinorUnits: 0, feeMinorUnits: 0, netMinorUnits: 0 },
    ]);
  });

  it("sums gross, fee and net into the paid-at month", () => {
    const s = summarizeRevenueSeries(
      [
        inv({ paidAt: new Date("2026-06-03T00:00:00.000Z") }),
        inv({ paidAt: new Date("2026-06-28T00:00:00.000Z") }),
        inv({
          paidAt: new Date("2026-07-01T00:00:00.000Z"),
          amountMinorUnits: 599,
          feeMinorUnits: 30,
          netMinorUnits: 569,
        }),
      ],
      months,
    );
    expect(s[1]).toEqual({
      month: "2026-06",
      grossMinorUnits: 1_598,
      feeMinorUnits: 80,
      netMinorUnits: 1_518,
    });
    expect(s[2]).toEqual({
      month: "2026-07",
      grossMinorUnits: 599,
      feeMinorUnits: 30,
      netMinorUnits: 569,
    });
  });

  it("ignores invoices outside the window and keeps month order", () => {
    const s = summarizeRevenueSeries(
      [inv({ paidAt: new Date("2026-01-10T00:00:00.000Z") })],
      months,
    );
    expect(s.map((p) => p.month)).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(s.every((p) => p.netMinorUnits === 0)).toBe(true);
  });

  // D-99: a not-yet-renewed pre-existing MXN invoice must not be blended into
  // the canonical GBP total as if it were the same unit.
  it("excludes a non-primary-currency invoice from the total", () => {
    const s = summarizeRevenueSeries(
      [
        inv({
          currency: "MXN",
          amountMinorUnits: 19_900,
          feeMinorUnits: 900,
          netMinorUnits: 19_000,
        }),
      ],
      months,
    );
    expect(s.every((p) => p.netMinorUnits === 0)).toBe(true);
  });

  it("resolves against an explicit primaryCurrency instead of the default", () => {
    const s = summarizeRevenueSeries(
      [
        inv({
          currency: "MXN",
          amountMinorUnits: 19_900,
          feeMinorUnits: 900,
          netMinorUnits: 19_000,
        }),
      ],
      months,
      "MXN",
    );
    expect(s.find((p) => p.month === "2026-07")!.netMinorUnits).toBe(19_000);
  });
});

describe("otherCurrencyRevenueTotals", () => {
  function inv(over: Partial<PaidInvoice> = {}): PaidInvoice {
    return {
      paidAt: new Date("2026-07-10T00:00:00.000Z"),
      amountMinorUnits: 799,
      feeMinorUnits: 40,
      netMinorUnits: 759,
      currency: "GBP",
      ...over,
    };
  }

  it("groups non-primary-currency invoices' net by currency and excludes the primary", () => {
    const totals = otherCurrencyRevenueTotals([
      inv({ currency: "MXN", netMinorUnits: 19_000 }),
      inv({ currency: "MXN", netMinorUnits: 14_200 }),
      inv({ currency: "GBP", netMinorUnits: 759 }),
    ]);
    expect(totals).toEqual({ MXN: 33_200 });
  });

  it("returns an empty object when every invoice is the primary currency", () => {
    expect(otherCurrencyRevenueTotals([inv()])).toEqual({});
  });
});

describe("summarizeGmvSeries", () => {
  const months = recentMonths(NOW, 2); // 2026-06, 2026-07

  function pay(over: Partial<PaidPayment> = {}): PaidPayment {
    return {
      paidAt: new Date("2026-07-10T00:00:00.000Z"),
      amountMinorUnits: 100_000,
      rail: "card",
      ...over,
    };
  }

  it("splits by rail and totals every paid payment", () => {
    const s = summarizeGmvSeries(
      [
        pay({ rail: "card", amountMinorUnits: 100_000 }),
        pay({ rail: "wise", amountMinorUnits: 80_000 }),
        pay({ rail: "unknown", amountMinorUnits: 20_000 }),
      ],
      months,
    );
    const jul = s.find((p) => p.month === "2026-07")!;
    expect(jul.cardMinorUnits).toBe(100_000);
    expect(jul.wiseMinorUnits).toBe(80_000);
    // total includes the unknown-rail payment; the two named buckets do not.
    expect(jul.totalMinorUnits).toBe(200_000);
  });

  it("buckets by paid-at month and zero-fills the rest", () => {
    const s = summarizeGmvSeries(
      [
        pay({
          paidAt: new Date("2026-06-15T00:00:00.000Z"),
          rail: "card",
          amountMinorUnits: 50_000,
        }),
      ],
      months,
    );
    expect(s[0]).toEqual({
      month: "2026-06",
      cardMinorUnits: 50_000,
      wiseMinorUnits: 0,
      totalMinorUnits: 50_000,
    });
    expect(s[1]).toEqual({
      month: "2026-07",
      cardMinorUnits: 0,
      wiseMinorUnits: 0,
      totalMinorUnits: 0,
    });
  });
});

describe("summarizeExpenseSeries", () => {
  const months = recentMonths(NOW, 3); // 2026-05, 2026-06, 2026-07

  function expense(over: Partial<PlatformExpenseRow> = {}): PlatformExpenseRow {
    return {
      periodMonth: new Date("2026-07-01T00:00:00.000Z"),
      amountMinorUnits: 4_000,
      currency: "GBP",
      category: "hosting",
      ...over,
    };
  }

  it("zero-fills every month in the window, including byCategory", () => {
    const s = summarizeExpenseSeries([], months);
    expect(s).toHaveLength(3);
    for (const point of s) {
      expect(point.totalMinorUnits).toBe(0);
      expect(point.byCategory).toEqual({
        hosting: 0,
        ai: 0,
        dev_tools: 0,
        monitoring: 0,
        email: 0,
        domain: 0,
        other: 0,
      });
    }
  });

  it("sums rows in the primary currency into the period month, split by category", () => {
    const s = summarizeExpenseSeries(
      [
        expense({
          periodMonth: new Date("2026-06-01T00:00:00.000Z"),
          category: "hosting",
          amountMinorUnits: 3_000,
        }),
        expense({
          periodMonth: new Date("2026-06-01T00:00:00.000Z"),
          category: "ai",
          amountMinorUnits: 1_500,
        }),
        expense({
          periodMonth: new Date("2026-07-01T00:00:00.000Z"),
          category: "ai",
          amountMinorUnits: 2_000,
        }),
      ],
      months,
    );
    const jun = s.find((p) => p.month === "2026-06")!;
    expect(jun.totalMinorUnits).toBe(4_500);
    expect(jun.byCategory.hosting).toBe(3_000);
    expect(jun.byCategory.ai).toBe(1_500);
    const jul = s.find((p) => p.month === "2026-07")!;
    expect(jul.totalMinorUnits).toBe(2_000);
    expect(jul.byCategory.ai).toBe(2_000);
  });

  it("excludes non-primary-currency rows from totals", () => {
    const s = summarizeExpenseSeries(
      [expense({ currency: "USD", amountMinorUnits: 999_999 })],
      months,
    );
    expect(s.every((p) => p.totalMinorUnits === 0)).toBe(true);
  });

  it("resolves against an explicit primaryCurrency instead of the default", () => {
    const s = summarizeExpenseSeries(
      [expense({ currency: "MXN", amountMinorUnits: 4_000 })],
      months,
      "MXN",
    );
    expect(s.find((p) => p.month === "2026-07")!.totalMinorUnits).toBe(4_000);
  });

  it("ignores rows outside the window and keeps month order", () => {
    const s = summarizeExpenseSeries(
      [expense({ periodMonth: new Date("2026-01-01T00:00:00.000Z") })],
      months,
    );
    expect(s.map((p) => p.month)).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(s.every((p) => p.totalMinorUnits === 0)).toBe(true);
  });
});

describe("otherCurrencyExpenseTotals", () => {
  function expense(over: Partial<PlatformExpenseRow> = {}): PlatformExpenseRow {
    return {
      periodMonth: new Date("2026-07-01T00:00:00.000Z"),
      amountMinorUnits: 1_000,
      currency: "GBP",
      category: "hosting",
      ...over,
    };
  }

  it("groups non-primary-currency rows by currency and excludes the primary", () => {
    const totals = otherCurrencyExpenseTotals([
      expense({ currency: "USD", amountMinorUnits: 500 }),
      expense({ currency: "USD", amountMinorUnits: 700 }),
      expense({ currency: "GBP", amountMinorUnits: 999 }),
    ]);
    expect(totals).toEqual({ USD: 1_200 });
  });

  it("returns an empty object when every row is the primary currency", () => {
    expect(otherCurrencyExpenseTotals([expense()])).toEqual({});
  });
});

describe("summarizeNetProfitSeries", () => {
  function revenue(over: Partial<RevenuePoint> = {}): RevenuePoint {
    return { month: "2026-07", grossMinorUnits: 0, feeMinorUnits: 0, netMinorUnits: 0, ...over };
  }
  function expensePoint(over: Partial<ExpensePoint> = {}): ExpensePoint {
    return {
      month: "2026-07",
      totalMinorUnits: 0,
      byCategory: { hosting: 0, ai: 0, dev_tools: 0, monitoring: 0, email: 0, domain: 0, other: 0 },
      ...over,
    };
  }

  it("nets revenue − expenses per month", () => {
    const s = summarizeNetProfitSeries(
      [revenue({ month: "2026-07", netMinorUnits: 10_000 })],
      [expensePoint({ month: "2026-07", totalMinorUnits: 3_000 })],
    );
    expect(s).toEqual([
      {
        month: "2026-07",
        revenueNetMinorUnits: 10_000,
        expenseMinorUnits: 3_000,
        netProfitMinorUnits: 7_000,
      },
    ]);
  });

  it("treats a missing month in expenses as zero", () => {
    const s = summarizeNetProfitSeries([revenue({ month: "2026-07", netMinorUnits: 10_000 })], []);
    expect(s[0]).toEqual({
      month: "2026-07",
      revenueNetMinorUnits: 10_000,
      expenseMinorUnits: 0,
      netProfitMinorUnits: 10_000,
    });
  });

  it("can go negative when expenses exceed revenue", () => {
    const s = summarizeNetProfitSeries(
      [revenue({ month: "2026-07", netMinorUnits: 1_000 })],
      [expensePoint({ month: "2026-07", totalMinorUnits: 5_000 })],
    );
    expect(s[0].netProfitMinorUnits).toBe(-4_000);
  });
});
