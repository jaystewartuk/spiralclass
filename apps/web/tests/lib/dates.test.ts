import { describe, expect, it } from "vitest";
import { addMonths } from "@/lib/dates";

// LOW-8: package expiry now uses real calendar months instead of the
// old `months * 30 days` approximation.

describe("addMonths", () => {
  it("lands on the same day-of-month N months out (not 30*N days)", () => {
    const start = new Date("2026-01-15T12:00:00Z");
    expect(addMonths(start, 12).toISOString()).toBe("2027-01-15T12:00:00.000Z");
    // The old 30-day approximation would have been ~2026-12-31 — 15 days early.
    expect(addMonths(start, 3).toISOString()).toBe("2026-04-15T12:00:00.000Z");
  });

  it("clamps to the last day of a shorter target month (Jan 31 + 1mo → Feb 28)", () => {
    const start = new Date("2026-01-31T00:00:00Z");
    expect(addMonths(start, 1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });

  it("handles leap February (Jan 31 2028 + 1mo → Feb 29)", () => {
    const start = new Date("2028-01-31T00:00:00Z");
    expect(addMonths(start, 1).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("rolls across a year boundary", () => {
    const start = new Date("2026-11-10T08:30:00Z");
    expect(addMonths(start, 3).toISOString()).toBe("2027-02-10T08:30:00.000Z");
  });

  it("does not mutate the input date", () => {
    const start = new Date("2026-01-15T12:00:00Z");
    const copy = new Date(start.getTime());
    addMonths(start, 6);
    expect(start.getTime()).toBe(copy.getTime());
  });
});
