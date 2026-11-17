import { describe, expect, it } from "vitest";
import {
  clockChangeNote,
  clockChangeShiftMinutes,
  clockChangeShiftsByBooking,
  formatClockShift,
} from "./clock-change";
import { createT } from "./i18n/translate";

// Issue 229. A teacher's weekly class stays put on HER clock across her clock
// change (D-53), so a student whose country changes on a different date, or not
// at all, sees it move by an hour on theirs — and nothing said so. These pin the
// three cases the issue names: the UK leaving summer time against a zone that
// has none, the US and the EU changing on different weekends, and a
// southern-hemisphere zone changing the opposite way.

/** 10:00 on the teacher's own clock, as a UTC instant. */
const at = (iso: string) => new Date(iso);

describe("clockChangeShiftMinutes", () => {
  it("UK leaves summer time, Mexico City has none: an hour later for the student", () => {
    // 10:00 London on 18 Oct (BST, 09:00Z) and 25 Oct (GMT, 10:00Z). Mexico
    // City is UTC-6 all year since 2022, so 03:00 becomes 04:00 there.
    const shift = clockChangeShiftMinutes(
      at("2026-10-18T09:00:00Z"),
      at("2026-10-25T10:00:00Z"),
      "America/Mexico_City",
      "Europe/London",
    );
    expect(shift).toBe(60);
  });

  it("the US and the EU change on different weekends: earlier, then back", () => {
    // A New York teacher's 10:00 class with a Madrid student. The US moves on
    // 8 March 2026, the EU on 29 March: for three weeks the gap is an hour
    // narrower, so the student's 16:00 becomes 15:00, then 16:00 again.
    const ny = "America/New_York";
    const madrid = "Europe/Madrid";
    const mar3 = at("2026-03-03T15:00:00Z"); // EST
    const mar10 = at("2026-03-10T14:00:00Z"); // EDT, Madrid still CET
    const mar17 = at("2026-03-17T14:00:00Z");
    const mar31 = at("2026-03-31T14:00:00Z"); // EDT, CEST
    expect(clockChangeShiftMinutes(mar3, mar10, madrid, ny)).toBe(-60);
    expect(clockChangeShiftMinutes(mar10, mar17, madrid, ny)).toBe(0);
    expect(clockChangeShiftMinutes(mar17, mar31, madrid, ny)).toBe(60);
  });

  it("a southern-hemisphere zone leaving summer time while the north enters it", () => {
    // Sydney leaves daylight time on 5 April 2026 (UTC+11 → +10); a Mexico City
    // teacher (no DST) sees nothing, her Sydney student an hour earlier.
    expect(
      clockChangeShiftMinutes(
        at("2026-03-31T16:00:00Z"),
        at("2026-04-07T16:00:00Z"),
        "Australia/Sydney",
        "America/Mexico_City",
      ),
    ).toBe(-60);
    // Against London, which moves the other way a week earlier, the gap closes
    // by two hours across a fortnight's break.
    expect(
      clockChangeShiftMinutes(
        at("2026-03-22T10:00:00Z"),
        at("2026-04-12T09:00:00Z"),
        "Australia/Sydney",
        "Europe/London",
      ),
    ).toBe(-120);
    // Lord Howe Island moves by half an hour, not one.
    expect(
      clockChangeShiftMinutes(
        at("2026-03-31T16:00:00Z"),
        at("2026-04-07T16:00:00Z"),
        "Australia/Lord_Howe",
        "America/Mexico_City",
      ),
    ).toBe(-30);
  });

  it("is zero for the same zone, and for an id the engine cannot resolve", () => {
    const a = at("2026-10-18T09:00:00Z");
    const b = at("2026-10-25T10:00:00Z");
    expect(clockChangeShiftMinutes(a, b, "Europe/London", "Europe/London")).toBe(0);
    expect(clockChangeShiftMinutes(a, b, "Not/AZone", "Europe/London")).toBe(0);
  });
});

describe("clockChangeShiftsByBooking", () => {
  const london = "Europe/London";
  const mexico = "America/Mexico_City";
  const row = (id: string, iso: string, pairKey = "p1", status = "scheduled") => ({
    id,
    pairKey,
    scheduledStart: at(iso),
    status,
  });

  it("compares each class with the one before it in the same pairing", () => {
    const shifts = clockChangeShiftsByBooking(
      [
        row("a", "2026-10-11T09:00:00Z", "p1", "completed"),
        row("b", "2026-10-18T09:00:00Z"),
        row("c", "2026-10-25T10:00:00Z"),
        row("d", "2026-11-01T10:00:00Z"),
      ],
      () => ({ studentTz: mexico, teacherTz: london }),
    );
    expect(shifts.get("c")).toBe(60);
    // Only the first class after the change carries it; the one after is
    // compared with that one, and nothing moved between them.
    expect(shifts.has("a")).toBe(false);
    expect(shifts.has("b")).toBe(false);
    expect(shifts.has("d")).toBe(false);
  });

  it("skips a canceled or moved class as the reference, and keeps pairings apart", () => {
    const shifts = clockChangeShiftsByBooking(
      [
        // Out of order on purpose: the helper sorts.
        row("c", "2026-10-25T10:00:00Z"),
        row("a", "2026-10-18T09:00:00Z"),
        row("x", "2026-10-22T09:00:00Z", "p1", "canceled_by_student"),
        row("y", "2026-10-23T09:00:00Z", "p1", "rescheduled"),
        // A different teacher's first class is not compared with p1's.
        row("z", "2026-10-26T10:00:00Z", "p2"),
      ],
      () => ({ studentTz: mexico, teacherTz: london }),
    );
    expect(shifts.get("c")).toBe(60);
    expect(shifts.has("z")).toBe(false);
  });

  it("says nothing when the student's zone is unknown", () => {
    // Student.timezone is optional. Computing in a guessed zone would announce
    // a move the student may never see, so an unknown zone is no notice at all.
    const shifts = clockChangeShiftsByBooking(
      [row("a", "2026-10-18T09:00:00Z"), row("b", "2026-10-25T10:00:00Z")],
      () => ({ studentTz: null, teacherTz: london }),
    );
    expect(shifts.size).toBe(0);
  });
});

describe("formatClockShift", () => {
  it("says hours when it is whole hours, minutes otherwise, in the reader's language", () => {
    expect(formatClockShift(60, "en")).toBe("1 hour");
    expect(formatClockShift(-120, "en")).toBe("2 hours");
    expect(formatClockShift(30, "en")).toBe("30 minutes");
    expect(formatClockShift(60, "es")).toBe("1 hora");
    expect(formatClockShift(60, "fr")).toBe("1\u00a0heure"); // French sets a no-break space
  });
});

describe("clockChangeNote", () => {
  it("tells the student, in their language, which way the class moved on their clock", () => {
    expect(clockChangeNote(createT("en"), "en", "student", 60, "Ana")).toBe(
      "The clocks have changed since your last class with Ana: the same time on their clock is now 1 hour later on yours.",
    );
    expect(clockChangeNote(createT("es"), "es", "student", -60, "Ana")).toContain(
      "1 hora más temprano",
    );
    expect(clockChangeNote(createT("fr"), "fr", "student", 60, "Ana")).toContain(
      "1\u00a0heure plus tard",
    );
  });

  it("tells the teacher the same move from her side, naming the student", () => {
    expect(clockChangeNote(createT("en"), "en", "teacher", -60, "Jules")).toBe(
      "The clocks have changed since Jules's last class: the same time on your clock is now 1 hour earlier on theirs.",
    );
  });

  it("is null when nothing moved", () => {
    expect(clockChangeNote(createT("en"), "en", "student", 0, "Ana")).toBeNull();
  });
});
