import { describe, expect, it } from "vitest";
import { previewRewardMinorUnits } from "./referrals";

describe("previewRewardMinorUnits", () => {
  it("takes a whole percent off the base", () => {
    expect(
      previewRewardMinorUnits({ kind: "percent", percent: 15, amount: null }, 200_000, "MXN"),
    ).toBe(30_000);
  });

  it("rounds a percent the same way the stored-code resolver does", () => {
    // 7% of 1,499.99 = 104.9993 → 10500 centavos, not 10499.
    expect(
      previewRewardMinorUnits({ kind: "percent", percent: 7, amount: null }, 149_999, "MXN"),
    ).toBe(10_500);
  });

  it("converts a fixed amount with the currency's own exponent", () => {
    expect(
      previewRewardMinorUnits({ kind: "fixed", percent: null, amount: 200 }, 200_000, "MXN"),
    ).toBe(20_000);
    // JPY has no minor unit — ¥200 off is 200, not 20,000.
    expect(
      previewRewardMinorUnits({ kind: "fixed", percent: null, amount: 200 }, 200_000, "JPY"),
    ).toBe(200);
  });

  it("never exceeds the package price", () => {
    expect(
      previewRewardMinorUnits({ kind: "fixed", percent: null, amount: 9_999 }, 50_000, "MXN"),
    ).toBe(50_000);
    expect(
      previewRewardMinorUnits({ kind: "percent", percent: 100, amount: null }, 50_000, "MXN"),
    ).toBe(50_000);
  });

  it("returns null while the selected kind has no value yet", () => {
    expect(
      previewRewardMinorUnits({ kind: "percent", percent: null, amount: 200 }, 200_000, "MXN"),
    ).toBeNull();
    expect(
      previewRewardMinorUnits({ kind: "fixed", percent: 15, amount: null }, 200_000, "MXN"),
    ).toBeNull();
    expect(
      previewRewardMinorUnits({ kind: "percent", percent: NaN, amount: null }, 200_000, "MXN"),
    ).toBeNull();
  });

  it("returns null rather than zero when there is no package to price against", () => {
    expect(
      previewRewardMinorUnits({ kind: "percent", percent: 15, amount: null }, 0, "MXN"),
    ).toBeNull();
  });
});
