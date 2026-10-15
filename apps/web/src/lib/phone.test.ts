import { describe, expect, it } from "vitest";
import { normalizeE164 } from "./phone";

describe("normalizeE164", () => {
  it("adds a leading + and strips spaces/hyphens", () => {
    expect(normalizeE164("52 55 1234-5678")).toBe("+525512345678");
  });
  it("keeps an existing +", () => {
    expect(normalizeE164("+5215512345678")).toBe("+5215512345678");
  });

  it("passes a country hint through the re-export to resolve another calling code", () => {
    // Full coverage of the hint's calling-code table lives in the canonical
    // suite (packages/shared/src/phone.test.ts) — this only checks the
    // re-export forwards the second argument.
    expect(normalizeE164("4155550123", "US")).toBe("+14155550123");
  });
});
