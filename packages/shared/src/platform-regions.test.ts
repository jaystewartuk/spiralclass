import { describe, expect, it } from "vitest";
import {
  currencyForRegion,
  DEFAULT_PLATFORM_REGION,
  isPlatformRegion,
  PLATFORM_MONEY_CURRENCY,
} from "./platform-regions";

describe("currencyForRegion", () => {
  it("returns GBP for the GB platform region", () => {
    expect(currencyForRegion("GB")).toBe("GBP");
  });

  it("falls back to the default region's currency for unknown / missing regions", () => {
    // A stray or not-yet-configured region must never mint a currency the
    // platform can't settle — it resolves to the default region (GBP today).
    expect(currencyForRegion("ZZ")).toBe("GBP");
    expect(currencyForRegion(null)).toBe("GBP");
    expect(currencyForRegion(undefined)).toBe("GBP");
    expect(currencyForRegion("")).toBe("GBP");
    // A legacy stored value from before the D-99 GB rename (existing DB rows
    // are backfilled by migration, but this guards the pre-migration instant
    // and any row a stray write recreates) also falls back safely.
    expect(currencyForRegion("MX")).toBe("GBP");
    // Sanity: the default region really is GB.
    expect(DEFAULT_PLATFORM_REGION).toBe("GB");
    expect(isPlatformRegion(DEFAULT_PLATFORM_REGION)).toBe(true);
  });

  it("PLATFORM_MONEY_CURRENCY matches the default region's currency", () => {
    expect(PLATFORM_MONEY_CURRENCY).toBe("GBP");
  });
});
