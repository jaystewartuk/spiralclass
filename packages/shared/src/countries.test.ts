import { describe, expect, it } from "vitest";
import {
  COUNTRY_CODES,
  DEFAULT_TEACHER_COUNTRY,
  SUPPORTED_CONNECT_COUNTRIES,
  countryFromTimezone,
  countryLabel,
  countryOptions,
  filterCountryOptions,
  isConnectCountrySupported,
  isIsoCountryCode,
} from "./countries";

describe("isConnectCountrySupported", () => {
  it("accepts the old cross-border circle (GB, US, CA, CH, EEA)", () => {
    for (const code of ["GB", "US", "CA", "CH", "ES", "DE", "IE", "NO"]) {
      expect(isConnectCountrySupported(code)).toBe(true);
    }
  });

  it("is case-insensitive on the input", () => {
    expect(isConnectCountrySupported("gb")).toBe(true);
  });

  it("accepts MX, BR, JP and the rest of the non-circle markets (D-143)", () => {
    // The inverse of what this file asserted until D-143. Under separate
    // charges and transfers these were unpayable, because the platform had to
    // Transfer across a border Stripe would not cross. Direct charges settle on
    // the teacher's OWN account in her OWN country, so the circle stopped
    // binding and these are exactly the markets the platform sells into.
    for (const code of ["MX", "BR", "JP", "SG", "TH", "AU", "NZ", "HK", "MY", "AE"]) {
      expect(isConnectCountrySupported(code)).toBe(true);
    }
  });

  it("rejects the countries Stripe actually refuses", () => {
    // Measured against Stripe test mode on 2026-08-30 with the exact config the
    // app creates, not inferred. IN refuses card_payments outright; the rest
    // return "v2 Account creation with configuration.merchant is currently
    // unavailable in <CC> for your platform". Each falls back to the manual
    // transfer rail.
    for (const code of ["IN", "ZA", "NG", "ID"]) {
      expect(isConnectCountrySupported(code)).toBe(false);
    }
  });

  it("rejects IS — a genuine NARROWING at D-143, not an oversight", () => {
    // Iceland was inside the old cross-border circle and IS creatable as a
    // merchant account. It is the one country the direct-charges migration
    // takes off the card rail. If a future probe shows Stripe has enabled it,
    // adding it back is a one-line change — but do not add it on the
    // assumption that EEA membership implies support.
    expect(isConnectCountrySupported("IS")).toBe(false);
  });

  it("lists exactly the measured merchant-capable set (guards a careless edit)", () => {
    // If this fails because a country was added, that is a real rail decision:
    // re-probe /v2/core/accounts for it before updating the expectation, rather
    // than making the test pass.
    expect([...SUPPORTED_CONNECT_COUNTRIES].sort()).toEqual([
      "AE",
      "AT",
      "AU",
      "BE",
      "BG",
      "BR",
      "CA",
      "CH",
      "CY",
      "CZ",
      "DE",
      "DK",
      "EE",
      "ES",
      "FI",
      "FR",
      "GB",
      "GI",
      "GR",
      "HK",
      "HR",
      "HU",
      "IE",
      "IT",
      "JP",
      "LI",
      "LT",
      "LU",
      "LV",
      "MT",
      "MX",
      "MY",
      "NL",
      "NO",
      "NZ",
      "PL",
      "PT",
      "RO",
      "SE",
      "SG",
      "SI",
      "SK",
      "TH",
      "US",
    ]);
  });
});

describe("isIsoCountryCode", () => {
  it("accepts two uppercase letters and rejects everything else", () => {
    expect(isIsoCountryCode("MX")).toBe(true);
    expect(isIsoCountryCode("mx")).toBe(false);
    expect(isIsoCountryCode("MEX")).toBe(false);
    expect(isIsoCountryCode("M1")).toBe(false);
    expect(isIsoCountryCode("")).toBe(false);
  });
});

describe("country catalog", () => {
  it("defaults to MX (the launch market)", () => {
    expect(DEFAULT_TEACHER_COUNTRY).toBe("MX");
  });

  it("every code is a valid ISO alpha-2 and the set is unique", () => {
    expect(COUNTRY_CODES.length).toBeGreaterThan(200);
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
    for (const code of COUNTRY_CODES) expect(isIsoCountryCode(code)).toBe(true);
  });

  it("includes both the supported country and common expansion markets", () => {
    for (const code of ["MX", "US", "GB", "BR", "ES", "JP"]) {
      expect(COUNTRY_CODES).toContain(code);
    }
  });
});

describe("countryLabel / countryOptions", () => {
  it("returns the static localized name per locale (device-independent)", () => {
    // Reads the shipped COUNTRY_NAMES catalog, not runtime Intl — so mobile
    // (Hermes, no reliable Intl.DisplayNames) renders the same real names as web
    // instead of raw codes.
    expect(countryLabel("MX", "en")).toBe("Mexico");
    expect(countryLabel("MX", "es-MX")).toBe("México");
    expect(countryLabel("US", "es-MX")).toBe("Estados Unidos");
    expect(countryLabel("GB", "en")).toBe("United Kingdom");
  });

  it("never returns a bare 2-letter code for a real country", () => {
    // Regression guard for the mobile picker showing "AD/AE/AF…": every catalog
    // entry must be a human name, not the code itself.
    for (const code of ["AD", "AE", "AF", "AR", "BR", "JP", "DE"]) {
      expect(countryLabel(code, "en")).not.toBe(code);
      expect(countryLabel(code, "es-MX")).not.toBe(code);
    }
  });

  it("every catalog code has a non-empty name in both locales", () => {
    for (const code of COUNTRY_CODES) {
      expect(countryLabel(code, "en")).toBeTruthy();
      expect(countryLabel(code, "es-MX")).toBeTruthy();
    }
  });

  it("falls back to the uppercased code for a code outside the catalog", () => {
    // Structurally invalid / unknown code: not in COUNTRY_NAMES, Intl throws or
    // returns nothing, so it degrades to the code rather than blank.
    expect(countryLabel("zzq", "en")).toBe("ZZQ");
  });

  it("returns one localized, alphabetically-sorted option per code", () => {
    const options = countryOptions("en");
    expect(options).toHaveLength(COUNTRY_CODES.length);
    const labels = options.map((o) => o.label);
    expect([...labels]).toEqual([...labels].sort((a, b) => a.localeCompare(b, "en")));
    expect(options.every((o) => o.code && o.label)).toBe(true);
  });
});

describe("filterCountryOptions", () => {
  const opts = [
    { code: "MX", label: "Mexico" },
    { code: "US", label: "United States" },
    { code: "BR", label: "Brazil" },
  ];

  it("returns all options for an empty or whitespace query", () => {
    expect(filterCountryOptions(opts, "")).toHaveLength(3);
    expect(filterCountryOptions(opts, "   ")).toHaveLength(3);
  });

  it("matches on label, case-insensitively", () => {
    expect(filterCountryOptions(opts, "braz").map((o) => o.code)).toEqual(["BR"]);
    expect(filterCountryOptions(opts, "UNITED").map((o) => o.code)).toEqual(["US"]);
  });

  it("matches on the ISO code too", () => {
    expect(filterCountryOptions(opts, "mx").map((o) => o.code)).toEqual(["MX"]);
  });

  it("returns empty when nothing matches", () => {
    expect(filterCountryOptions(opts, "zzz")).toEqual([]);
  });
});

describe("countryFromTimezone", () => {
  it("maps common IANA zones to their ISO country", () => {
    expect(countryFromTimezone("America/Mexico_City")).toBe("MX");
    expect(countryFromTimezone("America/Sao_Paulo")).toBe("BR");
    expect(countryFromTimezone("Europe/Madrid")).toBe("ES");
    expect(countryFromTimezone("Europe/London")).toBe("GB");
    expect(countryFromTimezone("Asia/Tokyo")).toBe("JP");
    expect(countryFromTimezone("America/Argentina/Buenos_Aires")).toBe("AR");
  });

  it("returns null for an unmapped or malformed zone", () => {
    expect(countryFromTimezone("Antarctica/Troll")).toBeNull();
    expect(countryFromTimezone("Not/AZone")).toBeNull();
    expect(countryFromTimezone("")).toBeNull();
  });

  it("only ever maps to real ISO codes we actually offer", () => {
    // A tz that resolves to a country missing from COUNTRY_CODES would let the
    // picker prefill an unselectable value. Spot-check the mapped outputs.
    for (const tz of ["America/Mexico_City", "Europe/Madrid", "Asia/Kolkata", "Africa/Lagos"]) {
      const code = countryFromTimezone(tz);
      expect(code && COUNTRY_CODES.includes(code as (typeof COUNTRY_CODES)[number])).toBe(true);
    }
  });
});
