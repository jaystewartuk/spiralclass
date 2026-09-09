import { describe, expect, it } from "vitest";
import { createT } from "@spiralclass/shared";
import {
  bookingWhen,
  formatZonedDateCompact,
  formatZonedShortDate,
  sameWallClock,
  timezoneCityLabel,
  zoneNow,
} from "./date-display";

// bookingWhen backs BookingCard's when/whenSecondary on both the student
// portal (my-classes) and the teacher dashboard (dashboard/classes) — the
// two highest-traffic class-time surfaces. Always viewer-primary,
// other-secondary, regardless of which role is viewing.

const t = createT("en");
const tEs = createT("es-MX");

// 16:00 UTC — 10:00 a.m. in Mexico City (UTC-6), 5:00 p.m. in London (BST, UTC+1).
const SCHEDULED_START = new Date("2026-07-15T16:00:00Z");

describe("bookingWhen", () => {
  it("shows the viewer's own time primary and the other party's secondary, labeled", () => {
    const result = bookingWhen(
      SCHEDULED_START,
      "America/Mexico_City",
      { tz: "Europe/London", label: "Alicia Moreno" },
      "en",
      t,
    );
    expect(result.when).toContain("10:00 AM");
    expect(result.whenSecondary).toContain("Alicia Moreno");
    expect(result.whenSecondary).toContain("5:00 PM");
  });

  it("is symmetric: swapping viewer/other swaps which time is primary", () => {
    const asStudent = bookingWhen(
      SCHEDULED_START,
      "America/Mexico_City",
      { tz: "Europe/London", label: "Teacher" },
      "en",
      t,
    );
    const asTeacher = bookingWhen(
      SCHEDULED_START,
      "Europe/London",
      { tz: "America/Mexico_City", label: "Student" },
      "en",
      t,
    );
    expect(asStudent.when).toContain("10:00 AM");
    expect(asTeacher.when).toContain("5:00 PM");
    expect(asStudent.whenSecondary).toContain("5:00 PM");
    expect(asTeacher.whenSecondary).toContain("10:00 AM");
  });

  it("still renders a secondary line when both parties share a timezone", () => {
    const result = bookingWhen(
      SCHEDULED_START,
      "America/Mexico_City",
      { tz: "America/Mexico_City", label: "Alicia Moreno" },
      "en",
      t,
    );
    expect(result.whenSecondary).toContain("Alicia Moreno");
    expect(result.whenSecondary).toContain("10:00 AM");
  });

  it("renders in Spanish when given the es-MX translator", () => {
    const result = bookingWhen(
      SCHEDULED_START,
      "America/Mexico_City",
      { tz: "Europe/London", label: "Alicia Moreno" },
      "es-MX",
      tEs,
    );
    expect(result.whenSecondary).toContain("Hora de Alicia Moreno");
  });

  it("handles a midnight-boundary date difference between viewer and other", () => {
    // 23:30 UTC -> Mexico City still same day 17:30, Tokyo already next day 08:30.
    const d = new Date("2026-07-15T23:30:00Z");
    const result = bookingWhen(
      d,
      "America/Mexico_City",
      { tz: "Asia/Tokyo", label: "Teacher" },
      "en",
      t,
    );
    expect(result.when).toContain("5:30 PM");
    expect(result.whenSecondary).toContain("8:30 AM");
  });
});

// The dashboard used to print `teachers.timezone` verbatim as its only
// subtitle. This is the copy half of that fix — a zone still has to be named
// (the product shows two parties' clocks), just not as a machine identifier.
describe("timezoneCityLabel", () => {
  it("renders the locality of a two-part zone id", () => {
    expect(timezoneCityLabel("America/Mexico_City")).toBe("Mexico City");
    expect(timezoneCityLabel("Europe/London")).toBe("London");
  });

  it("takes the LAST segment of a three-part id, not the middle one", () => {
    expect(timezoneCityLabel("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(timezoneCityLabel("America/Indiana/Indianapolis")).toBe("Indianapolis");
  });

  it("passes a segment-free id through unchanged", () => {
    // FALLBACK_TIMEZONE is UTC, and it must stay recognisable as UTC — that is
    // the whole reason the fallback is not a real market's zone (see CLAUDE.md).
    expect(timezoneCityLabel("UTC")).toBe("UTC");
  });
});

// The compact date on a student material's "from your class on …" badge, where
// the weekday and full month name formatZonedDayHeader prints would not fit.
describe("formatZonedShortDate", () => {
  const now = new Date("2026-07-15T12:00:00Z");

  it("omits the year inside the current year", () => {
    const result = formatZonedShortDate(
      new Date("2026-08-12T16:00:00Z"),
      "America/Mexico_City",
      "en",
      now,
    );
    expect(result).toContain("12");
    expect(result).toContain("Aug");
    expect(result).not.toContain("2026");
  });

  it("adds the year once the date leaves it", () => {
    const result = formatZonedShortDate(
      new Date("2024-08-12T16:00:00Z"),
      "America/Mexico_City",
      "en",
      now,
    );
    expect(result).toContain("2024");
  });

  // The zone decides the calendar day, not UTC — 01:00 UTC is still the
  // previous evening in Mexico City, and the badge has to say the day the
  // student had her class.
  it("reads the day in the given zone, not in UTC", () => {
    const justAfterMidnightUtc = new Date("2026-08-13T01:00:00Z");
    expect(formatZonedShortDate(justAfterMidnightUtc, "America/Mexico_City", "en", now)).toContain(
      "12",
    );
    expect(formatZonedShortDate(justAfterMidnightUtc, "UTC", "en", now)).toContain("13");
  });

  // The year test has to hold across the boundary too: a December class read
  // from a January "now" is a different year and must say so.
  it("compares years in the target zone rather than the runtime's", () => {
    const newYearsEveInMexico = new Date("2026-01-01T04:00:00Z");
    const laterThatYear = new Date("2026-06-01T12:00:00Z");
    expect(
      formatZonedShortDate(newYearsEveInMexico, "America/Mexico_City", "en", laterThatYear),
    ).toContain("2025");
  });

  it("formats in the requested locale", () => {
    const august = new Date("2026-08-12T16:00:00Z");
    expect(formatZonedShortDate(august, "UTC", "es-MX", now)).toContain("ago");
    expect(formatZonedShortDate(august, "UTC", "fr", now)).toContain("ao\u00fbt");
  });
});

// ICU emits a narrow no-break space before the meridiem in some versions and
// an ordinary space in others. The product does not care which; nor should
// these assertions.
const spaces = (value: string) => value.replace(/\u202f|\u00a0/g, " ");

describe("zoneNow", () => {
  // 02:00 UTC on the 16th is still the evening of the 15th in Mexico City. The
  // calendar dates differ, which is the fact a lone clock face cannot carry
  // and the reason `ymd` is exposed separately from the formatted `date`.
  const instant = new Date("2026-07-16T02:00:00Z");

  it("renders the wall clock, the locality and the calendar date of one zone", () => {
    const clock = zoneNow(instant, "America/Mexico_City", "en");
    expect(spaces(clock.time)).toBe("8:00 PM");
    // Not the raw IANA id — printing that as product copy is the defect this
    // whole strip replaces.
    expect(clock.city).toBe("Mexico City");
    expect(clock.ymd).toBe("2026-07-15");
    expect(clock.date).toContain("Jul");
  });

  it("puts two zones on different calendar days when they are", () => {
    expect(zoneNow(instant, "America/Mexico_City", "en").ymd).toBe("2026-07-15");
    expect(zoneNow(instant, "Europe/London", "en").ymd).toBe("2026-07-16");
  });

  it("formats the time in the VIEWER's locale, not the zone's country", () => {
    // fr is the registry's 24-hour locale; the zone rendered is unchanged.
    expect(spaces(zoneNow(instant, "America/Mexico_City", "fr").time)).toBe("20:00");
  });

  it("zero-pads ymd so two of them compare as strings", () => {
    const clock = zoneNow(new Date("2026-03-05T12:00:00Z"), "UTC", "en");
    expect(clock.ymd).toBe("2026-03-05");
    expect(clock.city).toBe("UTC");
  });

  it("follows a zone across its own DST boundary", () => {
    const summer = new Date("2026-07-15T16:00:00Z");
    const winter = new Date("2026-01-15T16:00:00Z");
    expect(spaces(zoneNow(summer, "Europe/London", "en").time)).toBe("5:00 PM"); // BST
    expect(spaces(zoneNow(winter, "Europe/London", "en").time)).toBe("4:00 PM"); // GMT
    // Mexico abolished DST in 2022 — CST all year, so its clock does not move.
    expect(spaces(zoneNow(summer, "America/Mexico_City", "en").time)).toBe("10:00 AM");
    expect(spaces(zoneNow(winter, "America/Mexico_City", "en").time)).toBe("10:00 AM");
  });
});

describe("sameWallClock", () => {
  const instant = new Date("2026-07-15T16:00:00Z");
  const at = (tz: string) => zoneNow(instant, tz, "en");

  it("is true for two zone ids that share one clock", () => {
    // The case it exists for: rendering these as two labelled clocks would be
    // noise dressed as information.
    expect(sameWallClock(at("Europe/London"), at("Europe/Lisbon"))).toBe(true);
  });

  it("is false when the hour differs", () => {
    expect(sameWallClock(at("Europe/London"), at("America/Mexico_City"))).toBe(false);
  });

  it("is false when only the calendar date differs", () => {
    // Same hour of the clock, a day apart — 07:00 on the 16th in Auckland is
    // 12:00 on the 15th in Honolulu under a 12-hour locale unless the date is
    // part of the comparison.
    const midnight = new Date("2026-07-16T02:00:00Z");
    const a = zoneNow(midnight, "America/Mexico_City", "en");
    const b = { ...a, ymd: "2026-07-16" };
    expect(sameWallClock(a, b)).toBe(false);
  });
});

// The student detail page printed a package expiry as
// `expiresAt.toISOString().slice(0, 10)` — unzoned and unlocalized, so a
// package expiring late in the evening in Mexico City showed the NEXT day,
// as digits, on a page where every other date was words.
describe("formatZonedDateCompact", () => {
  it("resolves the date in the target zone, not UTC", () => {
    // 2026-10-04T04:00Z is still 2026-10-03 in Mexico City: the bug.
    const late = new Date("2026-10-04T04:00:00Z");
    expect(formatZonedDateCompact(late, "America/Mexico_City", "en")).toContain("3");
    expect(formatZonedDateCompact(late, "UTC", "en")).toContain("4");
  });

  it("always carries the year, because expiries are read across one", () => {
    expect(formatZonedDateCompact(new Date("2026-10-03T15:00:00Z"), "UTC", "en")).toContain("2026");
  });

  it("gives a locale its own date order rather than a translated English one", () => {
    const d = new Date("2026-10-03T15:00:00Z");
    const en = formatZonedDateCompact(d, "UTC", "en");
    const es = formatZonedDateCompact(d, "UTC", "es-MX");
    expect(en).not.toBe(es);
    for (const out of [en, es]) {
      expect(out).not.toMatch(/^\d{4}-\d{2}-\d{2}$/); // never the raw ISO slice
    }
  });

  it("defaults to es-MX when no locale is given", () => {
    const d = new Date("2026-10-03T15:00:00Z");
    expect(formatZonedDateCompact(d, "UTC")).toBe(formatZonedDateCompact(d, "UTC", "es-MX"));
  });
});
