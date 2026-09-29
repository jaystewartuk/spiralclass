import { describe, expect, it } from "vitest";
import { formatMinorUnits } from "@spiralclass/shared";
import { chartValueFormatter } from "@/components/ui/chart-format";

// A money chart used to format with no currency, which defaults to MXN, so the
// admin console drew GBP revenue and costs as pesos (#27).
describe("chartValueFormatter", () => {
  it("formats money in the currency the caller names", () => {
    const gbp = chartValueFormatter({ valueFormat: "minorUnits", currency: "GBP" });
    expect(gbp(12_345)).toBe(formatMinorUnits(12_345, "GBP"));
    expect(gbp(12_345)).not.toBe(formatMinorUnits(12_345, "MXN"));
  });

  it("respects a zero-decimal currency", () => {
    const jpy = chartValueFormatter({ valueFormat: "minorUnits", currency: "JPY" });
    expect(jpy(5_000)).toBe(formatMinorUnits(5_000, "JPY"));
  });

  it("will not type-check a money chart with no currency", () => {
    // @ts-expect-error — minorUnits requires a currency
    chartValueFormatter({ valueFormat: "minorUnits" });
    // @ts-expect-error — a count has no currency to carry
    chartValueFormatter({ valueFormat: "number", currency: "GBP" });
  });

  it("formats a plain count as a number", () => {
    expect(chartValueFormatter({})(1234)).toBe((1234).toLocaleString());
  });
});
