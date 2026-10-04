import { describe, expect, it } from "vitest";
import { strings } from "../i18n/catalog";
import { BRAND_DOMAIN, BRAND_NAME, BRAND_WORDMARK } from "./name";

// The name is a constant because no language translates it. The catalog says
// it too, for copy that interpolates it; the two must never disagree, or a
// rename lands in one and not the other (D-138 was a rename).
describe("the product's name", () => {
  it("is the same in every catalog as in the constant", () => {
    for (const [locale, table] of Object.entries(strings)) {
      expect((table as Record<string, string>)["common.brandName"], locale).toBe(BRAND_NAME);
    }
  });

  it("has a wordmark and a domain that are the name's own", () => {
    expect(BRAND_WORDMARK).toBe(BRAND_NAME.toLowerCase());
    expect(BRAND_DOMAIN).toBe(`${BRAND_WORDMARK}.com`);
  });
});
