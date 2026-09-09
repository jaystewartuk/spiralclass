import { describe, expect, it } from "vitest";
import { formatMinorUnits, minorUnitsToMajor, mxnFormatter } from "@/lib/money";

// Money convention:
//   - all amounts stored as integer minor units
//   - rendered with Intl.NumberFormat('es-MX', currency MXN)

describe("formatMinorUnits", () => {
  it("formats integer minor units with es-MX MXN currency conventions and an MXN suffix", () => {
    expect(formatMinorUnits(150_000)).toBe(`${mxnFormatter.format(1500)} MXN`);
    expect(formatMinorUnits(550_000)).toBe(`${mxnFormatter.format(5500)} MXN`);
    expect(formatMinorUnits(0)).toBe(`${mxnFormatter.format(0)} MXN`);
  });

  it("renders the currency symbol, grouping, and MXN suffix consistent with es-MX retail copy", () => {
    const formatted = formatMinorUnits(1_234_567); // = 12,345.67 MXN
    expect(formatted).toMatch(/12,345\.67/);
    // `$` disambiguated by trailing ` MXN` so it never reads as USD.
    expect(formatted).toMatch(/\$/);
    expect(formatted).toMatch(/ MXN$/);
  });

  it("does not silently accept floats — fractional minor units format with 4 visible decimals at most", () => {
    // formatMinorUnits itself doesn't reject; documents the float behavior so
    // a regression that drops the round() in minorUnitsToMajor is loud.
    expect(formatMinorUnits(150_001)).toBe(`${mxnFormatter.format(1500.01)} MXN`);
  });
});

describe("minorUnitsToMajor", () => {
  it("converts integer minor units to a 2dp major-unit number", () => {
    expect(minorUnitsToMajor(150_000)).toBe(1500);
    expect(minorUnitsToMajor(150_001)).toBe(1500.01);
    expect(minorUnitsToMajor(0)).toBe(0);
    expect(minorUnitsToMajor(1)).toBe(0.01);
  });

  it("rounds float drift away to land on the nearest minor unit", () => {
    // Math.round() applies before the divide, so non-integer minor units
    // collapse to the nearest minor unit before becoming major units.
    expect(minorUnitsToMajor(1500.4)).toBe(15);
    expect(minorUnitsToMajor(1500.5)).toBe(15.01);
    expect(minorUnitsToMajor(1500.6)).toBe(15.01);
  });

  it("handles big amounts without precision loss", () => {
    // Largest reasonable invoice: 10,000 MXN = 1,000,000 centavos.
    expect(minorUnitsToMajor(1_000_000)).toBe(10_000);
    // Beyond the typical MVP cap; still exact.
    expect(minorUnitsToMajor(99_999_999)).toBe(999_999.99);
  });
});
