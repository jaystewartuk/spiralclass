import { describe, expect, it } from "vitest";
import { formatMinutes, formatSecondsNarrow } from "./duration";

// Durations in the reader's unit format. They were a number with "min", "m" or
// "s" glued on in JSX. English, Spanish and French output is what it was;
// the languages still to come get their own.

describe("formatMinutes", () => {
  // French joins number and unit with a no-break space, as French typography
  // does, so "60" and "min" never wrap onto separate lines. It reads the same.
  it("reads as it did in the three launched languages", () => {
    expect(formatMinutes(60, "en")).toBe("60 min");
    expect(formatMinutes(60, "es")).toBe("60 min");
    expect(formatMinutes(60, "fr").replace(/\s/g, " ")).toBe("60 min");
  });

  it("follows a regional tag to its language, and anything unknown to the default", () => {
    expect(formatMinutes(45, "es-MX")).toBe(formatMinutes(45, "es"));
    expect(formatMinutes(45, null)).toBe(formatMinutes(45, "en"));
  });
});

describe("formatSecondsNarrow", () => {
  it("reads as it did in the three launched languages", () => {
    for (const locale of ["en", "es", "fr"]) expect(formatSecondsNarrow(12, locale)).toBe("12s");
  });
});
