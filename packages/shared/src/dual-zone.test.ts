import { describe, expect, it } from "vitest";
import { getDualZoneTime, formatDualZoneText, type TimeZoneParty } from "./dual-zone";

const teacher = (tz: string): TimeZoneParty => ({ tz, label: "Teacher" });
const student = (tz: string): TimeZoneParty => ({ tz, label: "Student" });

describe("getDualZoneTime", () => {
  it("same timezone: both sides still render, same wall clock", () => {
    // 2026-07-15 16:00 UTC == 2026-07-15 17:00 Europe/London (BST)
    const d = new Date("2026-07-15T16:00:00Z");
    const dz = getDualZoneTime(d, teacher("Europe/London"), student("Europe/London"), "en");
    expect(dz.viewer.timeLabel).toBe(dz.other.timeLabel);
    expect(dz.sameWallClock).toBe(true);
    expect(dz.other.label).toBe("Student");
  });

  it("UK <-> Mexico: viewer primary is Mexico, other secondary is UK", () => {
    // 2026-07-15 16:00 UTC -> Mexico City (UTC-6) 10:00 AM, London (BST, UTC+1) 5:00 PM
    const d = new Date("2026-07-15T16:00:00Z");
    const dz = getDualZoneTime(
      d,
      student("America/Mexico_City"),
      teacher("Europe/London"),
      "en",
      d,
    );
    expect(dz.viewer.timeLabel).toMatch(/10:00 AM/i);
    expect(dz.other.timeLabel).toMatch(/5:00 PM/i);
    expect(dz.other.label).toBe("Teacher");
  });

  it("UK <-> Japan: large positive offset, date rolls to next day for Japan", () => {
    // 2026-07-15 22:00 UTC -> London (BST) 23:00 same day, Tokyo (+9) 07:00 next day
    const d = new Date("2026-07-15T22:00:00Z");
    const dz = getDualZoneTime(d, teacher("Europe/London"), student("Asia/Tokyo"), "en", d);
    expect(dz.viewer.timeLabel).toMatch(/11:00 PM/i);
    expect(dz.other.timeLabel).toMatch(/7:00 AM/i);
    expect(dz.sameCalendarDate).toBe(false);
  });

  it("Australia <-> USA: viewer=Sydney, other=New York", () => {
    const d = new Date("2026-01-15T04:00:00Z");
    const dz = getDualZoneTime(
      d,
      student("Australia/Sydney"),
      teacher("America/New_York"),
      "en",
      d,
    );
    // Sydney is UTC+11 in Jan (DST), NY is UTC-5 (EST)
    expect(dz.viewer.timeLabel).toMatch(/3:00 PM/i);
    expect(dz.other.timeLabel).toMatch(/11:00 PM/i);
    expect(dz.sameCalendarDate).toBe(false);
  });

  it("Europe <-> South America: London and Sao Paulo", () => {
    const d = new Date("2026-07-15T15:00:00Z");
    const dz = getDualZoneTime(d, teacher("Europe/London"), student("America/Sao_Paulo"), "en", d);
    expect(dz.viewer.timeLabel).toMatch(/4:00 PM/i); // BST = UTC+1
    expect(dz.other.timeLabel).toMatch(/12:00 PM/i); // Sao Paulo UTC-3 year-round since 2019
  });

  it("DST transition: same IANA zone, one instance before and one after UK clocks change", () => {
    // UK DST ends 2026-10-25 (BST -> GMT). Two weekly-recurring 10:00 London
    // lessons either side of the transition must both render as 10:00 London
    // local, but different UTC instants and a shifted Mexico-City-equivalent.
    const beforeDst = new Date("2026-10-18T09:00:00Z"); // BST: 10:00 London
    const afterDst = new Date("2026-10-25T10:00:00Z"); // GMT: 10:00 London
    const before = getDualZoneTime(
      beforeDst,
      teacher("Europe/London"),
      student("America/Mexico_City"),
      "en",
      beforeDst,
    );
    const after = getDualZoneTime(
      afterDst,
      teacher("Europe/London"),
      student("America/Mexico_City"),
      "en",
      afterDst,
    );
    expect(before.viewer.timeLabel).toMatch(/10:00 AM/i);
    expect(after.viewer.timeLabel).toMatch(/10:00 AM/i);
    // Mexico City has no DST — the equivalent local time shifts by an hour
    // across the UK's transition even though the London wall clock doesn't.
    expect(before.other.timeLabel).not.toBe(after.other.timeLabel);
  });

  it("midnight-boundary: calendar date differs between viewer and other", () => {
    // 2026-07-15 23:30 UTC -> Mexico City (UTC-6) still 2026-07-15 17:30,
    // Tokyo (UTC+9) already 2026-07-16 08:30.
    const d = new Date("2026-07-15T23:30:00Z");
    const dz = getDualZoneTime(d, student("America/Mexico_City"), teacher("Asia/Tokyo"), "en", d);
    expect(dz.sameCalendarDate).toBe(false);
  });

  it("uses the viewer's own 'today' reference, not the other party's", () => {
    const now = new Date("2026-07-15T12:00:00Z");
    // A class at 23:30 UTC on 2026-07-15 is still "today" for the Mexico
    // City viewer (17:30 local) but already "tomorrow" for a Tokyo other
    // party (08:30 local the next day).
    const classTime = new Date("2026-07-15T23:30:00Z");
    const dz = getDualZoneTime(
      classTime,
      student("America/Mexico_City"),
      teacher("Asia/Tokyo"),
      "en",
      now,
    );
    expect(dz.viewer.dateLabel).toBe("Today");
  });

  it("names today and tomorrow in EVERY registered locale, not just two", () => {
    // The regression this pins: the labels were `locale.startsWith("es") ? "Hoy"
    // : "Today"`, which quietly makes English the answer for French — so a
    // French teacher's class list read "Today" over a row dated "jeudi 10
    // septembre". Asserting `fr` explicitly is what stops the two-branch shape
    // coming back the next time a locale is added.
    const now = new Date("2026-07-15T18:00:00Z");
    const tomorrow = new Date("2026-07-16T18:00:00Z");
    const parties = [student("America/Mexico_City"), teacher("America/Mexico_City")] as const;

    const label = (d: Date, locale: string) =>
      getDualZoneTime(d, parties[0], parties[1], locale, now).viewer.dateLabel;

    expect(label(now, "en")).toBe("Today");
    expect(label(now, "es-MX")).toBe("Hoy");
    expect(label(now, "fr")).toBe("Aujourd'hui");
    expect(label(tomorrow, "en")).toBe("Tomorrow");
    expect(label(tomorrow, "es-MX")).toBe("Mañana");
    expect(label(tomorrow, "fr")).toBe("Demain");
    // An unregistered locale still gets a real answer rather than an empty one.
    expect(label(now, "de")).toBe("Today");
  });

  it("falls back to full IANA id when ICU has no real abbreviation (ambiguous offset)", () => {
    const d = new Date("2026-07-15T16:00:00Z");
    const dz = getDualZoneTime(
      d,
      student("America/Mexico_City"),
      teacher("Europe/London"),
      "en",
      d,
    );
    // Mexico City commonly resolves to "GMT-6" under small-icu builds — must not surface that as-is.
    expect(
      dz.viewer.tzDisplay === "America/Mexico_City" || /^[A-Z]{2,5}$/.test(dz.viewer.tzDisplay),
    ).toBe(true);
  });
});

describe("formatDualZoneText", () => {
  it("renders viewer line first, other line second with label", () => {
    const d = new Date("2026-07-15T16:00:00Z");
    const now = d;
    const text = formatDualZoneText(
      d,
      student("America/Mexico_City"),
      teacher("Europe/London"),
      "en",
      now,
    );
    const lines = text.split("\n");
    expect(lines[0]).toContain("Your time");
    expect(lines[1]).toContain("Teacher's time");
  });

  it("renders in Spanish when locale is es", () => {
    const d = new Date("2026-07-15T16:00:00Z");
    const text = formatDualZoneText(
      d,
      student("America/Mexico_City"),
      teacher("Europe/London"),
      "es-MX",
      d,
    );
    expect(text).toContain("Tu hora");
    expect(text).toContain("Hora de Teacher");
  });

  it("renders in French rather than defaulting a French recipient to English", () => {
    const d = new Date("2026-07-15T16:00:00Z");
    const text = formatDualZoneText(
      d,
      student("America/Mexico_City"),
      teacher("Europe/London"),
      "fr",
      d,
    );
    expect(text).toContain("Votre heure");
    expect(text).toContain("Heure de Teacher");
  });
});
