import { describe, expect, it } from "vitest";
import { nextWeekdayMatching } from "@/lib/seed/snap-weekday";

// Alicia Moreno's seed availability is Mon–Fri.
const MON_FRI = [1, 2, 3, 4, 5] as const;

describe("nextWeekdayMatching", () => {
  it("returns the input unchanged when the start weekday already matches", () => {
    // 2026-04-15 is a Wednesday in UTC.
    const wed = new Date("2026-04-15T10:00:00Z");
    const out = nextWeekdayMatching(wed, MON_FRI);
    expect(out.toISOString()).toBe(wed.toISOString());
    expect(out.getUTCDay()).toBe(3);
  });

  it("walks forward to the next allowed weekday when start is Saturday", () => {
    // 2026-04-18 is a Saturday in UTC. Mon-Fri allowed → next Monday.
    const sat = new Date("2026-04-18T10:00:00Z");
    const out = nextWeekdayMatching(sat, MON_FRI);
    expect(out.getUTCDay()).toBe(1);
    expect(out.toISOString()).toBe("2026-04-20T10:00:00.000Z");
  });

  it("walks forward across Sunday → Monday with a single-day offset", () => {
    // 2026-04-19 is a Sunday. Mon-Fri allowed → next day, Monday.
    const sun = new Date("2026-04-19T10:00:00Z");
    const out = nextWeekdayMatching(sun, MON_FRI);
    expect(out.getUTCDay()).toBe(1);
    // Same time-of-day, +1 day.
    expect(out.getTime() - sun.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("preserves the time-of-day component when offsetting forward", () => {
    // Saturday 17:30 UTC → Monday 17:30 UTC (DST-agnostic; helper
    // works in UTC).
    const satEvening = new Date("2026-04-18T17:30:00Z");
    const out = nextWeekdayMatching(satEvening, MON_FRI);
    expect(out.toISOString()).toBe("2026-04-20T17:30:00.000Z");
  });

  it("throws when allowedWeekdays is empty", () => {
    const wed = new Date("2026-04-15T10:00:00Z");
    expect(() => nextWeekdayMatching(wed, [])).toThrow(/empty/);
  });

  it("throws on out-of-range weekday values", () => {
    const wed = new Date("2026-04-15T10:00:00Z");
    expect(() => nextWeekdayMatching(wed, [7])).toThrow(/invalid weekday/);
    expect(() => nextWeekdayMatching(wed, [-1])).toThrow(/invalid weekday/);
  });

  it("supports non-contiguous allowed sets (e.g. Tue + Fri only)", () => {
    // 2026-04-15 (Wed) → next allowed is Friday 2026-04-17.
    const wed = new Date("2026-04-15T10:00:00Z");
    const out = nextWeekdayMatching(wed, [2, 5]);
    expect(out.getUTCDay()).toBe(5);
    expect(out.toISOString()).toBe("2026-04-17T10:00:00.000Z");
  });
});
