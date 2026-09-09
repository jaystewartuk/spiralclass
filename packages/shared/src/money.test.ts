import { describe, expect, it } from "vitest";
import {
  minorUnitsToMajor,
  currencyExponent,
  formatMinorUnits,
  formatGbp,
  formatPriceForBuyer,
  majorToMinorUnits,
} from "./money";
import { PRICING_CURRENCIES } from "./pricing-currency";

/**
 * Money is an integer count of minor units, and the conversion in both
 * directions is currency-aware.
 *
 * That second half is the one that costs money. Eight of the ~40 curated
 * pricing currencies have no minor unit at all — CLP, JPY, KRW, VND, PYG, UGX,
 * XAF, XOF — so a conversion that assumes two decimals multiplies those prices
 * by a hundred. It did: entry always multiplied by 100 while formatting divided
 * by the real exponent, and a 20,000 CLP price was stored as 2,000,000. Four of
 * those codes were missing from the exponent map and so were wrong in BOTH
 * directions, which made them round-trip correctly by accident and hid the bug.
 *
 * Every case below is a defect that reached a real page or a real row. None is
 * hypothetical, and the comments say which is which, because the reason a case
 * exists is the part that stops someone deleting it as redundant.
 */

// The public booking funnel shows prices to strangers, and a stranger reads a
// bare "$" as their own dollar. Measured on a live page: a 380 MXN package
// (about US$19) rendered "$380.00 MXN" and the top package "$6,400.00 MXN".
describe("formatPriceForBuyer", () => {
  it("never renders a bare $ for a non-USD dollar currency in English", () => {
    // The whole point. narrowSymbol collapses all of these to "$", including
    // under "en" — so this asserts the symbol, not just the string.
    expect(formatPriceForBuyer(150_000, "MXN", "en")).toBe("MX$1,500.00");
    expect(formatPriceForBuyer(38_000, "MXN", "en")).toBe("MX$380.00");
    expect(formatPriceForBuyer(150_000, "BRL", "en")).toBe("R$1,500.00");
  });

  it("keeps the bare $ for USD, where it is the correct symbol", () => {
    expect(formatPriceForBuyer(150_000, "USD", "en")).toBe("$1,500.00");
  });

  it("leaves an unambiguous symbol alone", () => {
    expect(formatPriceForBuyer(799, "GBP", "en")).toBe("£7.99");
    expect(formatPriceForBuyer(150_000, "EUR", "en")).toBe("€1,500.00");
    expect(formatPriceForBuyer(1500, "JPY", "en")).toBe("¥1,500");
  });

  it("never doubles the code for a currency that formats AS its code", () => {
    // These have no symbol in English CLDR data, so they already read as the
    // code. Appending one would reproduce the "KWD 150.000 KWD" doubling.
    for (const code of ["KWD", "CLP", "ARS", "COP", "UYU"]) {
      const formatted = formatPriceForBuyer(150_000, code, "en");
      expect(formatted.split(code).length - 1).toBe(1);
    }
  });

  it("respects a 0-decimal currency's exponent", () => {
    // Same trap formatMinorUnits guards: CLP has no minor unit, so 150_000
    // minor units is 150,000 pesos, not 1,500.
    expect(formatPriceForBuyer(150_000, "CLP", "en")).toContain("150,000");
  });

  it("keeps a market's own currency reading naturally in its own locale", () => {
    // A Spanish-facing booking page sells to readers who cannot misread the
    // peso sign, so it should not be given the foreigner's disambiguation.
    expect(formatPriceForBuyer(150_000, "MXN", "es-MX")).toBe("$1,500.00");
  });

  it("falls back to the in-product rendering rather than throwing on a bad locale", () => {
    // A price label must never be the thing that breaks the page, and the
    // LOCALE is the argument that can arrive malformed. "en_US" is the
    // realistic way: Intl requires the hyphenated BCP-47 tag and throws
    // RangeError on the underscored POSIX form — which this codebase already
    // uses elsewhere for OpenGraph's `locale` field, where underscores are what
    // the spec wants.
    expect(formatPriceForBuyer(150_000, "MXN", "en_US")).toBe(formatMinorUnits(150_000, "MXN"));
  });

  it("does NOT try to rescue a malformed currency code, because the database will not emit one", () => {
    // Deliberately asserting the throw, so nobody "fixes" it into a silent
    // fallback later. Intl rejects anything that is not three letters, and this
    // function does not catch that — because the guarantee is held one layer
    // down, by a CHECK constraint in the hand-authored invariants migration:
    //
    //   teachers_pricing_currency_iso_format
    //     CHECK ("pricing_currency" ~ '^[A-Z]{3}$')
    //
    // So a two-letter code cannot reach a price label through any real row. If
    // one ever does, the data is corrupt and a loud RangeError is the correct
    // outcome — a rendered "1,500.00 ZZ" would hide it behind a plausible
    // number, which is the failure mode this whole file exists to prevent.
    const malformed = "ZZ";
    expect(() => formatPriceForBuyer(150_000, malformed, "en")).toThrow(RangeError);
  });

  it("survives a caller with no currency at all", () => {
    // Reachable from a Prisma row selected without the column — the typed
    // signature can't prevent it at that boundary, and a thrown TypeError
    // there takes down the whole booking page rather than one label.
    const noCurrency = undefined as unknown as string;
    expect(() => formatPriceForBuyer(150_000, noCurrency, "en")).not.toThrow();
    expect(formatPriceForBuyer(150_000, noCurrency, "en")).toBe(formatMinorUnits(150_000));
  });

  it("formats every curated pricing currency without throwing", () => {
    for (const code of PRICING_CURRENCIES) {
      expect(() => formatPriceForBuyer(150_000, code, "en")).not.toThrow();
      expect(formatPriceForBuyer(150_000, code, "en").length).toBeGreaterThan(0);
    }
  });
});

describe("formatMinorUnits", () => {
  it("renders MXN with the disambiguating suffix by default", () => {
    expect(formatMinorUnits(150_000)).toBe("$1,500.00 MXN");
    expect(formatMinorUnits(0)).toBe("$0.00 MXN");
    expect(formatMinorUnits(99)).toBe("$0.99 MXN");
  });

  it("defaults to MXN when no currency is passed", () => {
    // MXN is the curated list's DEFAULT, not its content — the product prices
    // in about forty currencies (D-64). The default exists so the call sites
    // that predate multi-currency keep their exact output; it is not a claim
    // that there is one currency, and a new call site should pass the row's own.
    expect(formatMinorUnits(150_000)).toBe(formatMinorUnits(150_000, "MXN"));
  });

  it("renders a non-MXN currency by symbol, with the code exactly once", () => {
    // Regression: the es-MX formatter used to render every currency but MXN by
    // its bare code, and formatMinorUnits then appended the code again — "USD
    // 1,500.00 USD", "£"-less "GBP 7.99 GBP". Pin the symbol AND the single
    // code so neither half of that fix can rot.
    expect(formatMinorUnits(150_000, "USD")).toBe("$1,500.00 USD");
    expect(formatMinorUnits(150_000, "EUR")).toBe("€1,500.00 EUR");
    expect(formatMinorUnits(799, "GBP")).toBe("£7.99 GBP");
    expect(formatMinorUnits(150_000, "BRL")).toBe("R$1,500.00 BRL");
  });

  it("never repeats the currency code, for any currency a teacher can price in", () => {
    // The bug class, guarded across the whole curated list (D-64) rather than
    // the handful of codes spelled out above — a currency added to that list
    // without a CLDR narrow symbol must still come out with one code.
    for (const code of PRICING_CURRENCIES) {
      const formatted = formatMinorUnits(150_000, code);
      const occurrences = formatted.split(code).length - 1;
      expect(occurrences, `${code} rendered as "${formatted}"`).toBe(1);
    }
  });

  it("respects the currency minor-unit exponent (0-decimal currencies)", () => {
    // JPY has no minor unit: 1500 minor units == 1,500, not 15.00.
    expect(formatMinorUnits(1500, "JPY")).toBe("¥1,500 JPY");
    expect(formatMinorUnits(0, "JPY")).toBe("¥0 JPY");
  });

  it("respects 3-decimal currencies", () => {
    // KWD has 3 decimals: 1500 minor units == 1.500. It has no narrow symbol
    // in es-MX's CLDR data, so the formatter emits the code itself and
    // formatMinorUnits must NOT append a second one. ICU separates a code from
    // its amount with U+00A0, hence the explicit escape rather than a space.
    expect(formatMinorUnits(1500, "KWD")).toBe("KWD\u00a01.500");
  });

  it("accepts a lowercase currency code", () => {
    expect(formatMinorUnits(150_000, "mxn")).toBe("$1,500.00 MXN");
  });

  it("treats a currency absent from the exponent map as 2-decimal", () => {
    // This asserted MXN — a currency that IS in the map — so it proved the
    // 2-decimal default only by coincidence and would have gone on passing if
    // the fallback were removed. "XTS" is ISO 4217's reserved testing code:
    // three letters, so Intl accepts it, and absent from MINOR_UNIT_EXPONENTS,
    // so it exercises the branch the name describes.
    //
    // Intl has no symbol for it either, so the formatter emits the bare code
    // and formatMinorUnits must not append a second one — the same doubling
    // guarded above, arriving here through the unknown-currency path.
    expect(currencyExponent("XTS")).toBe(2);
    expect(formatMinorUnits(150_000, "XTS")).toBe("XTS\u00a01,500.00");
  });
});

describe("formatGbp", () => {
  it("renders a £ glyph with no disambiguating code suffix", () => {
    expect(formatGbp(123_456)).toBe("£1,234.56");
    expect(formatGbp(0)).toBe("£0.00");
    expect(formatGbp(99)).toBe("£0.99");
  });

  it("rounds to whole pence via the integer input (no fractional pence)", () => {
    expect(formatGbp(100)).toBe("£1.00");
  });
});

describe("currencyExponent", () => {
  it("defaults to 2 for common / unknown currencies", () => {
    expect(currencyExponent("MXN")).toBe(2);
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("ZZZ")).toBe(2);
  });

  it("returns 0 for 0-decimal currencies", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KRW")).toBe(0);
  });

  it("returns 3 for 3-decimal currencies", () => {
    expect(currencyExponent("KWD")).toBe(3);
    expect(currencyExponent("BHD")).toBe(3);
  });

  it("is case-insensitive", () => {
    expect(currencyExponent("jpy")).toBe(0);
  });
});

describe("minorUnitsToMajor", () => {
  it("converts integer minor units to a major-unit number, rounding the input", () => {
    expect(minorUnitsToMajor(150_000)).toBe(1500);
    expect(minorUnitsToMajor(99)).toBe(0.99);
    expect(minorUnitsToMajor(100.6)).toBe(1.01);
  });

  it("uses the currency exponent for the divisor", () => {
    // 0-decimal: minor units are already whole.
    expect(minorUnitsToMajor(1500, "JPY")).toBe(1500);
    // 3-decimal.
    expect(minorUnitsToMajor(1500, "KWD")).toBe(1.5);
  });
});

describe("majorToMinorUnits", () => {
  it("converts a major-unit amount to integer minor units (defaults MXN)", () => {
    expect(majorToMinorUnits(1500)).toBe(150_000);
    expect(majorToMinorUnits(0.99)).toBe(99);
    expect(majorToMinorUnits(0)).toBe(0);
  });

  it("rounds to the nearest minor unit", () => {
    expect(majorToMinorUnits(1.999)).toBe(200); // 199.9 → 200
    expect(majorToMinorUnits(1.991)).toBe(199);
  });

  it("uses the currency exponent instead of a hardcoded *100", () => {
    // 0-decimal: 1500 yen == 1500 minor units, not 150000.
    expect(majorToMinorUnits(1500, "JPY")).toBe(1500);
    // 3-decimal.
    expect(majorToMinorUnits(1.5, "KWD")).toBe(1500);
  });

  it("round-trips with minorUnitsToMajor for 2- and 0-decimal currencies", () => {
    expect(minorUnitsToMajor(majorToMinorUnits(1234.56))).toBe(1234.56);
    expect(minorUnitsToMajor(majorToMinorUnits(1500, "JPY"), "JPY")).toBe(1500);
  });
});
