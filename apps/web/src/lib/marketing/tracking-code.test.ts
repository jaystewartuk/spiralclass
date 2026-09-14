import { describe, expect, it } from "vitest";

import { newTrackingCode, TRACKING_ALPHABET, TRACKING_CODE_LENGTH } from "./tracking-code";

describe("newTrackingCode", () => {
  it("is ten characters from the typeable alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = newTrackingCode();
      expect(code).toHaveLength(TRACKING_CODE_LENGTH);
      for (const ch of code) expect(TRACKING_ALPHABET).toContain(ch);
    }
  });

  it("leaves out the characters a reader confuses", () => {
    for (const ch of ["l", "o", "0", "1"]) expect(TRACKING_ALPHABET).not.toContain(ch);
  });

  it("draws every character of the alphabet", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) for (const ch of newTrackingCode()) seen.add(ch);
    expect(seen.size).toBe(TRACKING_ALPHABET.length);
  });
});
