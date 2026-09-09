import { COUNTRY_CODES } from "./countries";
import { describe, expect, it } from "vitest";
import {
  CONNECT_CIRCLE_PRICING_CURRENCIES,
  currencyForTeacher,
  DEFAULT_PRICING_CURRENCY,
  defaultPricingCurrencyForCountry,
  isPricingCurrencySupported,
  pricingCurrenciesForCountry,
  stripeMinChargeMinorUnits,
  MANUAL_RAIL_PRICING_CURRENCIES,
  PRICING_CURRENCIES,
} from "./pricing-currency";

describe("isPricingCurrencySupported", () => {
  it("accepts every curated currency, case-insensitively", () => {
    for (const code of [...CONNECT_CIRCLE_PRICING_CURRENCIES, ...MANUAL_RAIL_PRICING_CURRENCIES]) {
      expect(isPricingCurrencySupported(code)).toBe(true);
      expect(isPricingCurrencySupported(code.toLowerCase())).toBe(true);
    }
  });

  it("rejects a currency outside the curated list", () => {
    // The list is curated, not every ISO 4217 code — these are real currencies
    // with no curated entry, so a teacher cannot select them.
    expect(isPricingCurrencySupported("ISK")).toBe(false);
    expect(isPricingCurrencySupported("XCD")).toBe(false);
    expect(isPricingCurrencySupported("")).toBe(false);
  });
});

describe("pricingCurrenciesForCountry", () => {
  // Rail-independent since D-143. The old split narrowed a card-rail teacher to
  // GBP/USD/EUR because her charge settled on the platform's GBP balance before
  // being transferred on. Direct charges settle on HER account in HER country,
  // so that narrowing became actively wrong: it would price a Mexican teacher's
  // business in a currency her own Stripe account does not settle in.
  it("offers the full curated list regardless of rail", () => {
    for (const country of ["GB", "US", "MX", "CO", "JP", "NG"]) {
      expect(pricingCurrenciesForCountry(country)).toBe(PRICING_CURRENCIES);
    }
  });

  it("lets a card-rail teacher price in her own country's currency", () => {
    // The regression this guards: MX is on the card rail now, and MXN must
    // still be offerable to her.
    expect(pricingCurrenciesForCountry("MX")).toContain("MXN");
    expect(pricingCurrenciesForCountry("JP")).toContain("JPY");
    expect(pricingCurrenciesForCountry("BR")).toContain("BRL");
  });
});

describe("defaultPricingCurrencyForCountry", () => {
  it("matches a Connect-circle country to its own curated currency", () => {
    expect(defaultPricingCurrencyForCountry("GB")).toBe("GBP");
    expect(defaultPricingCurrencyForCountry("US")).toBe("USD");
    expect(defaultPricingCurrencyForCountry("de")).toBe("EUR"); // case-insensitive
    expect(defaultPricingCurrencyForCountry("FR")).toBe("EUR");
  });

  it("matches a Wise-rail country to its own curated currency", () => {
    expect(defaultPricingCurrencyForCountry("MX")).toBe("MXN");
    expect(defaultPricingCurrencyForCountry("CO")).toBe("COP");
    expect(defaultPricingCurrencyForCountry("BR")).toBe("BRL");
  });

  it("returns null for a Connect-circle country with no curated match (CAD/CHF aren't curated)", () => {
    expect(defaultPricingCurrencyForCountry("CA")).toBeNull();
    expect(defaultPricingCurrencyForCountry("CH")).toBeNull();
  });

  it("returns null for a non-eurozone EEA country (e.g. Sweden, Norway)", () => {
    expect(defaultPricingCurrencyForCountry("SE")).toBeNull();
    expect(defaultPricingCurrencyForCountry("NO")).toBeNull();
  });

  // D-124 reversed this: these countries used to have no preselect because the
  // manual rail only offered six LatAm currencies. Now a teacher who banks in
  // Indonesia or India is offered her own money by default.
  it("preselects the home currency for a manual-rail country outside Latin America", () => {
    expect(defaultPricingCurrencyForCountry("ID")).toBe("IDR");
    expect(defaultPricingCurrencyForCountry("IN")).toBe("INR");
    expect(defaultPricingCurrencyForCountry("NG")).toBe("NGN");
  });

  // Still null where there is genuinely no confident match — the map is
  // best-effort, and a wrong preselect is worse than none.
  it("returns null for a country with no curated home currency", () => {
    expect(defaultPricingCurrencyForCountry("IS")).toBeNull();
    expect(defaultPricingCurrencyForCountry("CU")).toBeNull();
  });
});

describe("currencyForTeacher", () => {
  it("derives from the teacher's chosen pricing currency", () => {
    expect(currencyForTeacher({ pricingCurrency: "GBP" })).toBe("GBP");
    expect(currencyForTeacher({ pricingCurrency: "COP" })).toBe("COP");
  });

  it("falls back to MXN when the teacher has no value set", () => {
    expect(currencyForTeacher({ pricingCurrency: null })).toBe(DEFAULT_PRICING_CURRENCY);
    expect(currencyForTeacher({})).toBe(DEFAULT_PRICING_CURRENCY);
  });
});

describe("stripeMinChargeMinorUnits", () => {
  // Regression: the checkout min-charge gate was a single MXN 1000 constant for
  // every currency, so a Connect teacher priced in GBP/USD/EUR had normal
  // sub-10-unit sales (e.g. £8.00 = 800 pence) blocked outright.
  it("returns Stripe's real per-currency minimum, case-insensitively", () => {
    expect(stripeMinChargeMinorUnits("MXN")).toBe(1000);
    expect(stripeMinChargeMinorUnits("USD")).toBe(50);
    expect(stripeMinChargeMinorUnits("EUR")).toBe(50);
    expect(stripeMinChargeMinorUnits("GBP")).toBe(30);
    expect(stripeMinChargeMinorUnits("gbp")).toBe(30);
  });

  it("does NOT block a normal £8.00 class (800 pence > the GBP minimum)", () => {
    expect(800).toBeGreaterThanOrEqual(stripeMinChargeMinorUnits("GBP"));
  });

  it("falls back to a conservative 1000 for an unknown currency", () => {
    expect(stripeMinChargeMinorUnits("ZZZ")).toBe(1000);
  });
});

// D-124 widened the manual rail well past the original six LatAm currencies.
// These pin the properties that widening must not break.
describe("manual-rail widening (D-124)", () => {
  it("keeps every currency the original D-64 cut offered", () => {
    for (const code of ["MXN", "COP", "ARS", "CLP", "PEN", "BRL"]) {
      expect(MANUAL_RAIL_PRICING_CURRENCIES).toContain(code);
    }
  });

  // The gap D-124 set out to close: a teacher with a working local bank
  // account who could not price in her own money.
  it("lets a teacher price in her own currency outside Latin America", () => {
    for (const code of ["NGN", "INR", "PHP", "IDR", "KES", "ZAR", "VND", "TRY"]) {
      expect(MANUAL_RAIL_PRICING_CURRENCIES).toContain(code);
    }
  });

  // Very common for a teacher outside the Connect circle, and the single
  // biggest practical gap in the pre-D-124 list.
  it("offers the majors on the manual rail too", () => {
    for (const code of ["USD", "EUR", "GBP"]) {
      expect(MANUAL_RAIL_PRICING_CURRENCIES).toContain(code);
    }
  });

  it("contains no duplicates once both rails are combined", () => {
    expect(new Set(PRICING_CURRENCIES).size).toBe(PRICING_CURRENCIES.length);
  });

  it("never preselects a currency the teacher's rail cannot offer", () => {
    for (const country of COUNTRY_CODES) {
      const preselect = defaultPricingCurrencyForCountry(country);
      if (preselect === null) continue;
      expect(pricingCurrenciesForCountry(country)).toContain(preselect);
    }
  });
});
