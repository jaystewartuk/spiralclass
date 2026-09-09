import { describe, expect, it } from "vitest";

import {
  layoutOverlaps,
  minutesOfDayInTz,
  visibleHourRange,
  type TimedEvent,
} from "./calendar-layout";

const ev = (id: string, startMinutes: number, durationMinutes: number): TimedEvent => ({
  id,
  startMinutes,
  durationMinutes,
});

describe("minutesOfDayInTz", () => {
  it("converts a UTC instant to minutes-from-midnight in the target zone", () => {
    // Mexico abolished DST in 2022 → America/Mexico_City is UTC-6 year-round,
    // so 2026-06-15T16:30:00Z is 10:30 local.
    expect(minutesOfDayInTz("2026-06-15T16:30:00.000Z", "America/Mexico_City")).toBe(10 * 60 + 30);
  });

  it("is timezone-relative, not UTC", () => {
    const iso = "2026-06-15T16:30:00.000Z";
    expect(minutesOfDayInTz(iso, "UTC")).toBe(16 * 60 + 30);
    expect(minutesOfDayInTz(iso, "America/Mexico_City")).toBe(10 * 60 + 30);
  });

  it("folds midnight to 0", () => {
    expect(minutesOfDayInTz("2026-06-15T00:00:00.000Z", "UTC")).toBe(0);
  });
});

describe("layoutOverlaps", () => {
  it("gives non-overlapping events a single full-width column", () => {
    const out = layoutOverlaps([ev("a", 540, 60), ev("b", 660, 60)]);
    expect(out.map((e) => [e.id, e.column, e.columns])).toEqual([
      ["a", 0, 1],
      ["b", 0, 1],
    ]);
  });

  it("treats touching events (end === next start) as non-overlapping", () => {
    const out = layoutOverlaps([ev("a", 540, 60), ev("b", 600, 60)]);
    expect(out.every((e) => e.columns === 1)).toBe(true);
    expect(out.every((e) => e.column === 0)).toBe(true);
  });

  it("splits two overlapping events into two columns", () => {
    const out = layoutOverlaps([ev("a", 540, 60), ev("b", 570, 60)]);
    const a = out.find((e) => e.id === "a")!;
    const b = out.find((e) => e.id === "b")!;
    expect([a.column, a.columns]).toEqual([0, 2]);
    expect([b.column, b.columns]).toEqual([1, 2]);
  });

  it("reuses a freed column after an event in the cluster ends", () => {
    // a 9–11 overlaps b 9:30–10 and c 10–11. b frees column 1 at 10, so c
    // (which overlaps a, keeping the cluster alive) reuses column 1.
    const out = layoutOverlaps([ev("a", 540, 120), ev("b", 570, 30), ev("c", 600, 60)]);
    const byId = Object.fromEntries(out.map((e) => [e.id, e]));
    expect(byId.a.columns).toBe(2);
    expect(byId.a.column).toBe(0);
    expect(byId.b.column).toBe(1);
    expect(byId.c.column).toBe(1); // reused, not a third column
    expect(byId.c.columns).toBe(2);
  });

  it("separates events into independent clusters", () => {
    // Two overlapping in the morning, one alone in the afternoon.
    const out = layoutOverlaps([ev("a", 540, 60), ev("b", 570, 60), ev("c", 900, 60)]);
    const byId = Object.fromEntries(out.map((e) => [e.id, e]));
    expect(byId.a.columns).toBe(2);
    expect(byId.b.columns).toBe(2);
    expect(byId.c.columns).toBe(1); // its own cluster, full width
    expect(byId.c.column).toBe(0);
  });

  it("gives a zero-duration event a positive layout height", () => {
    const out = layoutOverlaps([ev("a", 540, 0)]);
    expect(out[0].layoutEnd).toBeGreaterThan(out[0].layoutStart);
  });

  it("returns events sorted by start", () => {
    const out = layoutOverlaps([ev("late", 660, 30), ev("early", 540, 30)]);
    expect(out.map((e) => e.id)).toEqual(["early", "late"]);
  });
});

describe("visibleHourRange", () => {
  it("defaults to a business-day window when events fit inside it", () => {
    expect(visibleHourRange([ev("a", 600, 60)])).toEqual({ startHour: 7, endHour: 21 });
  });

  it("expands downward for an early event", () => {
    expect(visibleHourRange([ev("a", 6 * 60 + 15, 60)]).startHour).toBe(6);
  });

  it("rounds the end up to the next whole hour so the last event isn't clipped", () => {
    // 20:30 + 60 = 21:30 → endHour 22.
    expect(visibleHourRange([ev("a", 20 * 60 + 30, 60)]).endHour).toBe(22);
  });

  it("clamps to [0, 24]", () => {
    const r = visibleHourRange([ev("a", 10, 30), ev("b", 23 * 60 + 30, 60)]);
    expect(r.startHour).toBe(0);
    expect(r.endHour).toBe(24);
  });

  it("honours custom defaults and keeps end > start for an empty day", () => {
    expect(visibleHourRange([], { defaultStartHour: 9, defaultEndHour: 17 })).toEqual({
      startHour: 9,
      endHour: 17,
    });
  });
});
