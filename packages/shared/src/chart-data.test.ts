import { describe, expect, it } from "vitest";
import { toBarSeries } from "./chart-data";

type Plan = "free" | "monthly" | "annual" | "founding";

const ORDER: Plan[] = ["free", "monthly", "annual", "founding"];
const LABELS: Record<Plan, string> = {
  free: "Free",
  monthly: "Monthly",
  annual: "Annual",
  founding: "Founding",
};
const COLORS: Record<Plan, string> = {
  free: "c1",
  monthly: "c2",
  annual: "c3",
  founding: "c4",
};

describe("toBarSeries", () => {
  it("maps counts onto the fixed order with their label and color", () => {
    const series = toBarSeries<Plan>({ monthly: 5, founding: 2 }, ORDER, LABELS, COLORS);

    expect(series).toEqual([
      { key: "free", label: "Free", value: 0, color: "c1" },
      { key: "monthly", label: "Monthly", value: 5, color: "c2" },
      { key: "annual", label: "Annual", value: 0, color: "c3" },
      { key: "founding", label: "Founding", value: 2, color: "c4" },
    ]);
  });

  it("keeps the caller's order regardless of key order in the counts record", () => {
    const series = toBarSeries<Plan>(
      { founding: 1, free: 9, annual: 3, monthly: 4 },
      ORDER,
      LABELS,
      COLORS,
    );

    expect(series.map((d) => d.key)).toEqual(ORDER);
  });

  it("defaults missing counts to zero rather than dropping the category", () => {
    const series = toBarSeries<Plan>({}, ORDER, LABELS, COLORS);
    expect(series).toHaveLength(4);
    expect(series.every((d) => d.value === 0)).toBe(true);
  });
});
