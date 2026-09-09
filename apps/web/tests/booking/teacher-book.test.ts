import { describe, expect, it } from "vitest";
import {
  bookHref,
  dayPartOf,
  filterRoster,
  groupSlotsByDayPart,
  normalizeRosterSearch,
  orderRoster,
  resolveBookableDay,
  ROSTER_SEARCH_MAX_LENGTH,
  type RosterEntry,
} from "@/lib/booking/teacher-book";
import { teacherBookingErrorKey } from "@/lib/booking/teacher-booking-errors";
import { capitalizeFirst } from "@/lib/date-display";

// The decisions behind /dashboard/classes/book, tested away from the page:
// which day the URL asks for, how a day's times are banded, which students
// lead the roster, and which sentence a failure becomes.

describe("resolveBookableDay", () => {
  const MIN = "2026-06-15";
  const MAX = "2026-08-14";

  it("keeps a day already inside the window", () => {
    expect(resolveBookableDay("2026-07-01", MIN, MAX)).toBe("2026-07-01");
    expect(resolveBookableDay(MIN, MIN, MAX)).toBe(MIN);
    expect(resolveBookableDay(MAX, MIN, MAX)).toBe(MAX);
  });

  it("clamps a real date that falls outside it", () => {
    expect(resolveBookableDay("2026-01-01", MIN, MAX)).toBe(MIN);
    expect(resolveBookableDay("2027-01-01", MIN, MAX)).toBe(MAX);
  });

  it("rejects anything that is not a genuine calendar date", () => {
    // THE REGRESSION. The previous version clamped the raw string, and a
    // non-date sorts above every real `YYYY-MM-DD`, so `?date=zzz` silently
    // opened the LAST bookable day — two months out — rather than today.
    expect(resolveBookableDay("zzz", MIN, MAX)).toBeNull();
    expect(resolveBookableDay("2026-13-01", MIN, MAX)).toBeNull();
    expect(resolveBookableDay("2026-02-30", MIN, MAX)).toBeNull();
    expect(resolveBookableDay("2026-6-1", MIN, MAX)).toBeNull();
    expect(resolveBookableDay(undefined, MIN, MAX)).toBeNull();
    expect(resolveBookableDay("", MIN, MAX)).toBeNull();
  });
});

describe("dayPartOf", () => {
  it("splits the day at noon and at 5pm", () => {
    expect(dayPartOf(0)).toBe("morning");
    expect(dayPartOf(11)).toBe("morning");
    expect(dayPartOf(12)).toBe("afternoon");
    expect(dayPartOf(16)).toBe("afternoon");
    expect(dayPartOf(17)).toBe("evening");
    expect(dayPartOf(23)).toBe("evening");
  });
});

describe("groupSlotsByDayPart", () => {
  const at = (hour: number) => ({ hour });

  it("keeps the bands in clock order and the slots in their given order", () => {
    const groups = groupSlotsByDayPart([at(19), at(9), at(13), at(10)], (s) => s.hour);
    expect(groups.map((g) => g.part)).toEqual(["morning", "afternoon", "evening"]);
    expect(groups[0].slots.map((s) => s.hour)).toEqual([9, 10]);
    expect(groups[1].slots.map((s) => s.hour)).toEqual([13]);
    expect(groups[2].slots.map((s) => s.hour)).toEqual([19]);
  });

  it("drops bands with nothing in them", () => {
    // A teacher who only works mornings gets one heading, not three — a
    // heading over an empty grid is furniture on every load.
    const groups = groupSlotsByDayPart([at(8), at(9)], (s) => s.hour);
    expect(groups).toHaveLength(1);
    expect(groups[0].part).toBe("morning");
  });

  it("returns nothing for a day with no slots", () => {
    expect(groupSlotsByDayPart([], (s: { hour: number }) => s.hour)).toEqual([]);
  });
});

describe("orderRoster", () => {
  const entry = (over: Partial<RosterEntry> & { studentId: string }): RosterEntry => ({
    name: over.studentId,
    email: null,
    classesAvailable: 0,
    sortDate: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  });

  it("puts students this flow can finish for first", () => {
    const ordered = orderRoster([
      entry({ studentId: "empty-new", sortDate: new Date("2026-06-01T00:00:00.000Z") }),
      entry({
        studentId: "bookable-old",
        classesAvailable: 3,
        sortDate: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ]);
    expect(ordered.map((e) => e.studentId)).toEqual(["bookable-old", "empty-new"]);
  });

  it("orders newest-first inside each group", () => {
    const ordered = orderRoster([
      entry({
        studentId: "older",
        classesAvailable: 1,
        sortDate: new Date("2026-01-01T00:00:00.000Z"),
      }),
      entry({
        studentId: "newer",
        classesAvailable: 1,
        sortDate: new Date("2026-06-01T00:00:00.000Z"),
      }),
    ]);
    expect(ordered.map((e) => e.studentId)).toEqual(["newer", "older"]);
  });

  it("does not mutate the input", () => {
    const input = [entry({ studentId: "a" }), entry({ studentId: "b", classesAvailable: 2 })];
    orderRoster(input);
    expect(input.map((e) => e.studentId)).toEqual(["a", "b"]);
  });
});

describe("filterRoster", () => {
  const roster: RosterEntry[] = [
    {
      studentId: "1",
      name: "Marcela Ruiz",
      email: "marcela@example.com",
      classesAvailable: 2,
      sortDate: new Date(),
    },
    {
      studentId: "2",
      name: "Sofía Álvarez",
      email: null,
      classesAvailable: 0,
      sortDate: new Date(),
    },
  ];

  it("matches on name or email, case-insensitively", () => {
    expect(filterRoster(roster, "marc").map((e) => e.studentId)).toEqual(["1"]);
    expect(filterRoster(roster, "EXAMPLE.COM").map((e) => e.studentId)).toEqual(["1"]);
    expect(filterRoster(roster, "sofía").map((e) => e.studentId)).toEqual(["2"]);
  });

  it("returns everyone for an empty or blank query", () => {
    expect(filterRoster(roster, "")).toHaveLength(2);
    expect(filterRoster(roster, "   ")).toHaveLength(2);
  });

  it("returns nothing rather than everything when nothing matches", () => {
    expect(filterRoster(roster, "zzz")).toEqual([]);
  });
});

describe("normalizeRosterSearch", () => {
  it("trims, and caps an unbounded parameter", () => {
    expect(normalizeRosterSearch("  mira  ")).toBe("mira");
    expect(normalizeRosterSearch(undefined)).toBe("");
    expect(normalizeRosterSearch(["mira", "beto"])).toBe("mira");
    expect(normalizeRosterSearch("x".repeat(500))).toHaveLength(ROSTER_SEARCH_MAX_LENGTH);
  });
});

describe("bookHref", () => {
  it("builds each step's URL, omitting what is not set", () => {
    expect(bookHref({})).toBe("/dashboard/classes/book");
    expect(bookHref({ date: "2026-07-01" })).toBe("/dashboard/classes/book?date=2026-07-01");
    expect(bookHref({ studentId: "s1", packageId: "p1", date: "2026-07-01" })).toBe(
      "/dashboard/classes/book?studentId=s1&packageId=p1&date=2026-07-01",
    );
  });

  it("escapes a value rather than pasting it into the query", () => {
    expect(bookHref({ q: "a&b=c" })).toBe("/dashboard/classes/book?q=a%26b%3Dc");
  });
});

describe("teacherBookingErrorKey", () => {
  it("maps every code the action returns to its own catalog entry", () => {
    expect(teacherBookingErrorKey("invalid")).toBe("teacherBook.error.invalid");
    expect(teacherBookingErrorKey("package-not-found")).toBe("teacherBook.error.package-not-found");
    expect(teacherBookingErrorKey("package-exhausted")).toBe("teacherBook.error.package-exhausted");
    expect(teacherBookingErrorKey("package-expired")).toBe("teacherBook.error.package-expired");
    expect(teacherBookingErrorKey("slot-taken")).toBe("teacherBook.error.slot-taken");
    expect(teacherBookingErrorKey("slot-unavailable")).toBe("teacherBook.error.slot-unavailable");
  });

  it("still yields a sentence for a code it has never seen", () => {
    // A client bundle can outlive a deploy; showing the widest true wording
    // beats rendering a raw code or throwing inside render.
    expect(teacherBookingErrorKey("something-new")).toBe("teacherBook.error.slot-unavailable");
  });
});

describe("capitalizeFirst", () => {
  it("raises only the first letter, leaving the rest of the phrase alone", () => {
    // The bug it replaces: CSS `capitalize` rendered this as
    // "Jueves, 12 De Junio De 2026".
    expect(capitalizeFirst("jueves, 12 de junio de 2026", "es-MX")).toBe(
      "Jueves, 12 de junio de 2026",
    );
    expect(capitalizeFirst("jeudi 12 juin 2026", "fr")).toBe("Jeudi 12 juin 2026");
  });

  it("leaves an already-capitalised phrase and an empty string untouched", () => {
    expect(capitalizeFirst("Thursday, 12 June 2026", "en")).toBe("Thursday, 12 June 2026");
    expect(capitalizeFirst("", "en")).toBe("");
  });
});
