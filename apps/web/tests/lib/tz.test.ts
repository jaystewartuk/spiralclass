import { describe, expect, it } from "vitest";
import { fromZonedTime } from "date-fns-tz";

import {
  formatDateTimeInZone,
  intervalsOverlap,
  normalizeInputDate,
  toYMD,
  weekdayInZone,
  zonedWallClockToUtc,
} from "@/lib/tz";

// Single source of truth for timezone-aware calendar math. Slot generation
// and notifications both lean on these helpers; a wrong wall-clock → UTC
// conversion (or a DST off-by-one) ripples into double-booking bugs.

const MX = "America/Mexico_City";
const LON = "Europe/London";

describe("zonedWallClockToUtc", () => {
  it("returns a UTC Date matching the wall-clock in the given zone (no DST)", () => {
    // CDMX is UTC-6 year-round; 09:00 local on 2026-04-15 → 15:00 UTC.
    const d = zonedWallClockToUtc("2026-04-15", "09:00", MX);
    expect(d.toISOString()).toBe("2026-04-15T15:00:00.000Z");
  });

  it("respects DST in London (BST is UTC+1)", () => {
    // 2026-06-21 falls in BST: 09:00 local → 08:00 UTC.
    const summer = zonedWallClockToUtc("2026-06-21", "09:00", LON);
    expect(summer.toISOString()).toBe("2026-06-21T08:00:00.000Z");

    // 2026-12-21 falls in GMT: 09:00 local → 09:00 UTC.
    const winter = zonedWallClockToUtc("2026-12-21", "09:00", LON);
    expect(winter.toISOString()).toBe("2026-12-21T09:00:00.000Z");
  });

  it("agrees with date-fns-tz on the inverse direction", () => {
    const ours = zonedWallClockToUtc("2026-04-15", "17:30", MX);
    const theirs = fromZonedTime("2026-04-15T17:30:00", MX);
    expect(ours.toISOString()).toBe(theirs.toISOString());
  });
});

describe("toYMD", () => {
  it("returns YYYY-MM-DD in the given zone", () => {
    // Late-night UTC instant that is still the same calendar day in CDMX.
    const utc = new Date("2026-04-15T23:00:00.000Z"); // 17:00 in CDMX
    expect(toYMD(utc, MX)).toBe("2026-04-15");
  });

  it("rolls over correctly across the zone's midnight", () => {
    // 03:00 UTC on 2026-04-16 = 21:00 on 2026-04-15 in CDMX
    const utc = new Date("2026-04-16T03:00:00.000Z");
    expect(toYMD(utc, MX)).toBe("2026-04-15");
    // ...but the same instant is already 2026-04-16 in UTC.
    expect(toYMD(utc, "UTC")).toBe("2026-04-16");
  });

  it("zero-pads month and day to two digits", () => {
    const d = new Date("2026-01-05T12:00:00Z");
    expect(toYMD(d, MX)).toBe("2026-01-05");
  });

  it("throws a clear error for an invalid timezone instead of a silent bad value", () => {
    expect(() => toYMD(new Date("2026-01-05T12:00:00Z"), "Not/AZone")).toThrow();
  });
});

describe("weekdayInZone", () => {
  it("returns 0 for Sunday … 6 for Saturday in the given zone", () => {
    // 2026-04-13 is a Monday in CDMX at noon.
    const monNoon = zonedWallClockToUtc("2026-04-13", "12:00", MX);
    expect(weekdayInZone(monNoon, MX)).toBe(1);

    const sunNoon = zonedWallClockToUtc("2026-04-12", "12:00", MX);
    expect(weekdayInZone(sunNoon, MX)).toBe(0);

    const satNoon = zonedWallClockToUtc("2026-04-18", "12:00", MX);
    expect(weekdayInZone(satNoon, MX)).toBe(6);
  });

  it("disagrees across zones when the instant crosses midnight", () => {
    // 2026-04-13 23:00 CDMX (Monday) = 2026-04-14 05:00 UTC (Tuesday)
    const lateMonInCdmx = zonedWallClockToUtc("2026-04-13", "23:00", MX);
    expect(weekdayInZone(lateMonInCdmx, MX)).toBe(1); // Mon
    expect(weekdayInZone(lateMonInCdmx, "UTC")).toBe(2); // Tue
  });
});

describe("normalizeInputDate", () => {
  it("passes strings through unchanged", () => {
    expect(normalizeInputDate("2026-04-15", MX)).toBe("2026-04-15");
  });

  it("converts Date objects to YMD in the requested zone", () => {
    const utc = new Date("2026-04-16T03:00:00Z"); // 21:00 on 04-15 CDMX
    expect(normalizeInputDate(utc, MX)).toBe("2026-04-15");
    expect(normalizeInputDate(utc, "UTC")).toBe("2026-04-16");
  });
});

describe("intervalsOverlap", () => {
  // Half-open: [a,b) overlaps [c,d) iff a < d && c < b.
  const t = (iso: string) => new Date(iso);

  it("returns false for touching but non-overlapping intervals (a ends == b starts)", () => {
    expect(
      intervalsOverlap(
        t("2026-04-15T10:00:00Z"),
        t("2026-04-15T11:00:00Z"),
        t("2026-04-15T11:00:00Z"),
        t("2026-04-15T12:00:00Z"),
      ),
    ).toBe(false);
  });

  it("returns true for any actual overlap (a contains, partial, contained-by)", () => {
    // partial overlap
    expect(
      intervalsOverlap(
        t("2026-04-15T10:00:00Z"),
        t("2026-04-15T11:00:00Z"),
        t("2026-04-15T10:30:00Z"),
        t("2026-04-15T11:30:00Z"),
      ),
    ).toBe(true);
    // contained-within
    expect(
      intervalsOverlap(
        t("2026-04-15T10:00:00Z"),
        t("2026-04-15T12:00:00Z"),
        t("2026-04-15T10:30:00Z"),
        t("2026-04-15T11:00:00Z"),
      ),
    ).toBe(true);
  });

  it("returns false when intervals are entirely disjoint", () => {
    expect(
      intervalsOverlap(
        t("2026-04-15T10:00:00Z"),
        t("2026-04-15T11:00:00Z"),
        t("2026-04-15T13:00:00Z"),
        t("2026-04-15T14:00:00Z"),
      ),
    ).toBe(false);
  });

  it("is symmetric in its arguments", () => {
    const a1 = t("2026-04-15T10:00:00Z");
    const a2 = t("2026-04-15T12:00:00Z");
    const b1 = t("2026-04-15T11:00:00Z");
    const b2 = t("2026-04-15T13:00:00Z");
    expect(intervalsOverlap(a1, a2, b1, b2)).toBe(intervalsOverlap(b1, b2, a1, a2));
  });
});

describe("formatDateTimeInZone", () => {
  it("renders a human-readable date+time string in the teacher's zone", () => {
    const d = new Date("2026-04-15T15:00:00Z"); // 09:00 CDMX
    const out = formatDateTimeInZone(d, MX);
    // ICU shape: "Wednesday, April 15 at 9:00 AM" (NBSP and case may vary).
    expect(out).toMatch(/wednesday/i);
    expect(out).toMatch(/april 15/i);
    // 9, not 09 — the hour carries no leading zero in a 12-hour locale (packages/shared/src/time-format.ts).
    expect(out).toMatch(/9:00/);
  });

  it("honors an explicit locale override", () => {
    const d = new Date("2026-04-15T15:00:00Z");
    const out = formatDateTimeInZone(d, MX, "en-US");
    expect(out).toMatch(/Wednesday/);
    expect(out).toMatch(/April 15/);
  });

  it("flips the date when crossing zones changes the day", () => {
    const d = new Date("2026-04-16T01:00:00Z"); // still 04-15 in CDMX, 04-16 in UTC
    expect(formatDateTimeInZone(d, MX)).toMatch(/april 15/i);
    expect(formatDateTimeInZone(d, "UTC")).toMatch(/april 16/i);
  });
});
