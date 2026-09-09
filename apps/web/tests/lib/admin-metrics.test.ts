import { describe, expect, it } from "vitest";
import { recentMonths } from "@/lib/money-metrics";
import { summarizeSignupSeries } from "@/lib/admin-metrics";

// Mid-month so nothing accidentally lands on a boundary.
const NOW = new Date("2026-07-15T12:00:00.000Z");

describe("summarizeSignupSeries", () => {
  const months = recentMonths(NOW, 3); // 2026-05, 2026-06, 2026-07

  it("zero-fills every month in the window", () => {
    expect(summarizeSignupSeries([], months)).toEqual([
      { month: "2026-05", label: "May '26", count: 0 },
      { month: "2026-06", label: "Jun '26", count: 0 },
      { month: "2026-07", label: "Jul '26", count: 0 },
    ]);
  });

  it("buckets signups into their UTC calendar month", () => {
    const createdAts = [
      new Date("2026-05-03T00:00:00.000Z"),
      new Date("2026-06-10T00:00:00.000Z"),
      new Date("2026-06-20T23:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z"),
    ];
    const series = summarizeSignupSeries(createdAts, months);
    expect(series).toEqual([
      { month: "2026-05", label: "May '26", count: 1 },
      { month: "2026-06", label: "Jun '26", count: 2 },
      { month: "2026-07", label: "Jul '26", count: 1 },
    ]);
  });

  it("ignores signups outside the given window", () => {
    const createdAts = [new Date("2026-01-01T00:00:00.000Z")];
    const series = summarizeSignupSeries(createdAts, months);
    expect(series.every((p) => p.count === 0)).toBe(true);
  });
});
