import { describe, expect, it } from "vitest";
import { normalizeE164 } from "@/lib/phone";

// normalizeE164 canonicalises pasted phone numbers to E.164 with a leading
// `+`. The zod schemas upstream already guarantee digits + optional leading
// `+`, so this only has to strip whitespace/hyphens and ensure the prefix.

describe("normalizeE164", () => {
  it("prepends + when missing", () => {
    expect(normalizeE164("521234567890")).toBe("+521234567890");
  });

  it("leaves an existing + in place", () => {
    expect(normalizeE164("+521234567890")).toBe("+521234567890");
  });

  it("strips spaces and hyphens", () => {
    expect(normalizeE164("+52 12-3456 7890")).toBe("+521234567890");
  });

  it("strips separators before adding the prefix", () => {
    expect(normalizeE164("52-12-34")).toBe("+521234");
  });
});
