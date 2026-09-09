import { describe, expect, it } from "vitest";
import { normalizeE164, phoneMatchVariants } from "./phone";

describe("normalizeE164", () => {
  it("adds a leading + and strips spaces/hyphens", () => {
    expect(normalizeE164("52 55 1234-5678")).toBe("+525512345678");
  });
  it("keeps an existing +", () => {
    expect(normalizeE164("+5215512345678")).toBe("+5215512345678");
  });

  it("passes a country hint through the re-export to resolve a non-MX calling code", () => {
    // Full coverage of the hint's calling-code table lives in the canonical
    // suite (packages/shared/src/phone.test.ts) — this only checks the
    // re-export forwards the second argument.
    expect(normalizeE164("4155550123", "US")).toBe("+14155550123");
  });
});

describe("phoneMatchVariants", () => {
  it("returns the canonical +digits form for a non-MX number", () => {
    expect(phoneMatchVariants("+14155550123")).toEqual(["+14155550123"]);
  });

  it("reconciles a modern MX number (+52 + 10 digits) with the legacy 1 form", () => {
    const v = phoneMatchVariants("+525512345678");
    expect(v).toContain("+525512345678");
    expect(v).toContain("+5215512345678");
    expect(v).toHaveLength(2);
  });

  it("reconciles a legacy MX number (+521 + 10 digits) with the modern form", () => {
    const v = phoneMatchVariants("+5215512345678");
    expect(v).toContain("+5215512345678");
    expect(v).toContain("+525512345678");
    expect(v).toHaveLength(2);
  });

  it("matches regardless of the input's leading + (GoTrue user.phone has none)", () => {
    expect(phoneMatchVariants("5215512345678")).toEqual(phoneMatchVariants("+5215512345678"));
  });

  it("tolerates spacing/punctuation", () => {
    const v = phoneMatchVariants("+52 (55) 1234-5678");
    expect(v).toContain("+525512345678");
    expect(v).toContain("+5215512345678");
  });

  it("returns an empty list for empty/garbage input", () => {
    expect(phoneMatchVariants("")).toEqual([]);
    expect(phoneMatchVariants("abc")).toEqual([]);
  });

  it("does not invent a 1-variant for an MX number of unexpected length", () => {
    // +52 followed by 9 digits — neither the 10- nor 11-digit case; leave as-is.
    expect(phoneMatchVariants("+52123456789")).toEqual(["+52123456789"]);
  });
});
