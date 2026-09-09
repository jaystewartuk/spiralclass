import { describe, expect, it } from "vitest";
import { createT } from "@spiralclass/shared";
import { groupBookingsByDay } from "@/lib/booking-day-groups";
import type { AppLocale } from "@/lib/i18n";

// Day-grouping for the classes list
// — Today/Tomorrow labels near the reference instant, weekday-date labels
// beyond that, one group per calendar day in the given timezone.
//
// The labels come from the real catalog rather than a stub: the bug this file
// missed for a year was an inline `locale === "en" ? "Today" : "Hoy"`, which a
// stubbed `t` would have hidden all over again.

const TZ = "America/Mexico_City";

function booking(iso: string) {
  return { scheduledStart: new Date(iso) };
}

/** The four arguments that never vary in a case, bound to one locale. */
function group(bookings: { scheduledStart: Date }[], tz: string, locale: AppLocale, now: Date) {
  return groupBookingsByDay(bookings, tz, locale, now, createT(locale));
}

describe("groupBookingsByDay", () => {
  it("labels the reference day as Hoy/Today", () => {
    const now = new Date("2026-07-01T12:00:00-06:00");
    const groups = group([booking("2026-07-01T17:00:00-06:00")], TZ, "es-MX", now);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Hoy");
    expect(groups[0].relative).toBe("today");

    const groupsEn = group([booking("2026-07-01T17:00:00-06:00")], TZ, "en", now);
    expect(groupsEn[0].label).toBe("Today");
  });

  it("labels the next calendar day as Mañana/Tomorrow", () => {
    const now = new Date("2026-07-01T12:00:00-06:00");
    const groups = group([booking("2026-07-02T09:00:00-06:00")], TZ, "es-MX", now);
    expect(groups[0].label).toBe("Mañana");
    expect(groups[0].relative).toBe("tomorrow");

    const groupsEn = group([booking("2026-07-02T09:00:00-06:00")], TZ, "en", now);
    expect(groupsEn[0].label).toBe("Tomorrow");
  });

  it("names the two relative days in French rather than falling back to Spanish", () => {
    // The regression this replaces: the labels were an inline en/es ternary, so
    // every locale that was not "en" got the Spanish word — a French teacher's
    // list said "Hoy" while `classes.group.today` held "Aujourd'hui" the whole
    // time. It shipped on this page and the student portal alike.
    const now = new Date("2026-07-01T12:00:00-06:00");
    expect(group([booking("2026-07-01T17:00:00-06:00")], TZ, "fr", now)[0].label).toBe(
      "Aujourd'hui",
    );
    expect(group([booking("2026-07-02T09:00:00-06:00")], TZ, "fr", now)[0].label).toBe("Demain");
  });

  it("labels Tomorrow correctly across a DST fall-back in a border zone", () => {
    // America/Tijuana falls back 2026-11-01 (a 25-hour day). At 00:30 local on
    // the 1st, now + 86,400,000 ms lands back on the 1st at 23:30 (the day
    // gained an hour), so the fixed-offset math set "tomorrow" to TODAY — and
    // a genuine next-day (Nov 2) booking got a plain date label instead of
    // "Tomorrow". The calendar-day increment gets it right.
    const BORDER_TZ = "America/Tijuana";
    const now = new Date("2026-11-01T00:30:00-07:00"); // 00:30 local, before fall-back
    const realTomorrow = group(
      [booking("2026-11-02T09:00:00-08:00")], // Nov 2 local (post-DST offset)
      BORDER_TZ,
      "en",
      now,
    );
    expect(realTomorrow[0].label).toBe("Tomorrow");

    const today = group(
      [booking("2026-11-01T20:00:00-08:00")], // still Nov 1 local
      BORDER_TZ,
      "en",
      now,
    );
    expect(today[0].label).toBe("Today");
  });

  it("falls back to a weekday date label beyond tomorrow", () => {
    const now = new Date("2026-07-01T12:00:00-06:00");
    const groups = group([booking("2026-07-10T11:00:00-06:00")], TZ, "en", now);
    expect(groups[0].label).toMatch(/Friday/);
    expect(groups[0].label).toMatch(/July 10/);
    // Nothing to emphasise: the caller uses this to weight today and tomorrow.
    expect(groups[0].relative).toBeNull();
  });

  it("buckets same-day bookings into one group, in encounter order", () => {
    const now = new Date("2026-07-01T00:00:00-06:00");
    const groups = group(
      [
        booking("2026-07-03T11:00:00-06:00"),
        booking("2026-07-03T15:00:00-06:00"),
        booking("2026-07-10T11:00:00-06:00"),
      ],
      TZ,
      "en",
      now,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].items).toHaveLength(1);
  });

  it("returns no groups for an empty booking list", () => {
    const now = new Date("2026-07-01T00:00:00-06:00");
    expect(group([], TZ, "en", now)).toEqual([]);
  });
});
