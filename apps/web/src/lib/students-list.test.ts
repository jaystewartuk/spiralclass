import { describe, expect, it } from "vitest";
import {
  EXPIRING_SOON_DAYS,
  LOW_BALANCE_CLASSES,
  STUDENT_SEARCH_MAX_LENGTH,
  calendarDaysUntil,
  compareRoster,
  foldForSearch,
  matchesStudentSearch,
  needsAttention,
  normalizeStudentSearch,
  resolveStudentScope,
  resolveStudentSort,
  rosterFlags,
  rosterNote,
  studentsHref,
  type RosterStudent,
} from "@/lib/students-list";

const TZ = "America/Mexico_City";
/** 2026-09-01, 09:00 in Mexico City. */
const NOW = new Date("2026-09-01T15:00:00.000Z");
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function student(overrides: Partial<RosterStudent> = {}): RosterStudent {
  return {
    studentId: "s1",
    name: "Mira López",
    email: "mira@correo.mx",
    phoneE164: "+525512345678",
    linkedAt: new Date("2026-01-01T00:00:00.000Z"),
    archived: false,
    notLive: false,
    levelLabel: "B1",
    agreedPriceCount: 0,
    activePackage: { total: 8, left: 5, expiresAt: inDays(90) },
    hasUpcomingClass: true,
    ...overrides,
  };
}

describe("resolveStudentScope", () => {
  it("accepts the three known views", () => {
    expect(resolveStudentScope("active")).toBe("active");
    expect(resolveStudentScope("attention")).toBe("attention");
    expect(resolveStudentScope("archived")).toBe("archived");
  });

  it("falls back to the roster for anything else", () => {
    // A view preference, not a resource: a stale bookmark should still show
    // the teacher her students rather than an error.
    expect(resolveStudentScope(undefined)).toBe("active");
    expect(resolveStudentScope("ARCHIVED")).toBe("active");
    expect(resolveStudentScope("../../etc/passwd")).toBe("active");
  });

  it("takes the first value when the parameter is repeated", () => {
    expect(resolveStudentScope(["archived", "attention"])).toBe("archived");
  });
});

describe("resolveStudentSort", () => {
  it("accepts the three orders and defaults to recent", () => {
    expect(resolveStudentSort("name")).toBe("name");
    expect(resolveStudentSort("balance")).toBe("balance");
    expect(resolveStudentSort("recent")).toBe("recent");
    expect(resolveStudentSort("nope")).toBe("recent");
    expect(resolveStudentSort(undefined)).toBe("recent");
  });
});

describe("normalizeStudentSearch", () => {
  it("returns an empty string for no search", () => {
    expect(normalizeStudentSearch(undefined)).toBe("");
    expect(normalizeStudentSearch("   ")).toBe("");
  });

  it("trims and caps the term", () => {
    expect(normalizeStudentSearch("  Mira ")).toBe("Mira");
    expect(normalizeStudentSearch("a".repeat(200))).toHaveLength(STUDENT_SEARCH_MAX_LENGTH);
  });
});

describe("foldForSearch", () => {
  it("folds case and strips diacritics", () => {
    // The reason the roster is searched in memory at all — Postgres ILIKE
    // folds case and nothing else, so "lopez" finds nobody named "López".
    expect(foldForSearch("LÓPEZ")).toBe("lopez");
    expect(foldForSearch("Peña")).toBe("pena");
    expect(foldForSearch("Müller")).toBe("muller");
    expect(foldForSearch("Renée")).toBe("renee");
  });
});

describe("matchesStudentSearch", () => {
  const row = student();

  it("matches an unaccented spelling of an accented name", () => {
    expect(matchesStudentSearch(row, "lopez")).toBe(true);
    expect(matchesStudentSearch(row, "LÓPEZ")).toBe(true);
  });

  it("matches on email", () => {
    expect(matchesStudentSearch(row, "correo.mx")).toBe(true);
  });

  it("matches a phone number typed the way a person types it", () => {
    // Nobody types a number back the way E.164 stores it.
    expect(matchesStudentSearch(row, "55 1234")).toBe(true);
    expect(matchesStudentSearch(row, "5512345678")).toBe(true);
  });

  it("does not match an unrelated term", () => {
    expect(matchesStudentSearch(row, "marcela")).toBe(false);
  });

  it("treats an empty term as no filter", () => {
    expect(matchesStudentSearch(row, "")).toBe(true);
  });

  it("survives a student with no email or phone", () => {
    const bare = student({ email: null, phoneE164: null });
    expect(matchesStudentSearch(bare, "mira")).toBe(true);
    expect(matchesStudentSearch(bare, "555")).toBe(false);
  });
});

describe("studentsHref", () => {
  it("omits the default scope and sort, so the canonical roster has a bare URL", () => {
    expect(studentsHref("active")).toBe("/dashboard/students");
    expect(studentsHref("active", { sort: "recent" })).toBe("/dashboard/students");
  });

  it("carries the view, the search and the order", () => {
    expect(studentsHref("attention")).toBe("/dashboard/students?show=attention");
    expect(studentsHref("active", { search: "Mira", sort: "balance" })).toBe(
      "/dashboard/students?q=Mira&sort=balance",
    );
  });

  it("encodes a term that would otherwise break the query string", () => {
    expect(studentsHref("active", { search: "a&b=c" })).toBe("/dashboard/students?q=a%26b%3Dc");
  });
});

describe("calendarDaysUntil", () => {
  it("counts calendar days in the teacher's zone, not 24-hour blocks", () => {
    expect(calendarDaysUntil(NOW, NOW, TZ)).toBe(0);
    expect(calendarDaysUntil(inDays(1), NOW, TZ)).toBe(1);
    expect(calendarDaysUntil(inDays(-3), NOW, TZ)).toBe(-3);
  });

  it("calls tomorrow morning 'tomorrow' from late tonight", () => {
    // 2026-09-01 23:30 in Mexico City → 2026-09-02 05:30 UTC.
    const lateTonight = new Date("2026-09-02T05:30:00.000Z");
    const tomorrowMorning = new Date("2026-09-02T15:00:00.000Z");
    expect(calendarDaysUntil(tomorrowMorning, lateTonight, TZ)).toBe(1);
    // A duration would have called this 0 — under ten hours apart.
  });
});

describe("rosterFlags", () => {
  it("reports a healthy student as needing nothing", () => {
    const flags = rosterFlags(student(), NOW, TZ);
    expect(needsAttention(flags)).toBe(false);
  });

  it("flags a staged student who has never been introduced", () => {
    const flags = rosterFlags(student({ notLive: true }), NOW, TZ);
    expect(flags.notLive).toBe(true);
    expect(needsAttention(flags)).toBe(true);
  });

  it("flags a student with no package at all", () => {
    const flags = rosterFlags(student({ activePackage: null }), NOW, TZ);
    expect(flags.noPackage).toBe(true);
    expect(flags.lowBalance).toBe(false);
    expect(flags.unbooked).toBe(false);
  });

  it("treats a spent package as no package rather than as running low", () => {
    // Two chips for one fact, otherwise.
    const flags = rosterFlags(
      student({ activePackage: { total: 8, left: 0, expiresAt: null } }),
      NOW,
      TZ,
    );
    expect(flags.noPackage).toBe(true);
    expect(flags.lowBalance).toBe(false);
  });

  it("flags a balance at the threshold, not only below it", () => {
    const flags = rosterFlags(
      student({ activePackage: { total: 8, left: LOW_BALANCE_CLASSES, expiresAt: null } }),
      NOW,
      TZ,
    );
    expect(flags.lowBalance).toBe(true);
  });

  it("separates an expiry inside the window from one past it", () => {
    const soon = rosterFlags(
      student({ activePackage: { total: 8, left: 5, expiresAt: inDays(EXPIRING_SOON_DAYS) } }),
      NOW,
      TZ,
    );
    expect(soon.expiringSoon).toBe(true);
    expect(soon.expired).toBe(false);

    const gone = rosterFlags(
      student({ activePackage: { total: 8, left: 5, expiresAt: inDays(-1) } }),
      NOW,
      TZ,
    );
    expect(gone.expired).toBe(true);
    expect(gone.expiringSoon).toBe(false);
  });

  it("does not call a distant expiry attention", () => {
    const flags = rosterFlags(
      student({ activePackage: { total: 8, left: 5, expiresAt: inDays(EXPIRING_SOON_DAYS + 1) } }),
      NOW,
      TZ,
    );
    expect(flags.expiringSoon).toBe(false);
    expect(needsAttention(flags)).toBe(false);
  });

  it("flags credit with nothing on the calendar", () => {
    const flags = rosterFlags(student({ hasUpcomingClass: false }), NOW, TZ);
    expect(flags.unbooked).toBe(true);
    expect(needsAttention(flags)).toBe(true);
  });

  it("does not call a spent package 'unbooked' — there is nothing to book", () => {
    const flags = rosterFlags(
      student({ activePackage: { total: 8, left: 0, expiresAt: null }, hasUpcomingClass: false }),
      NOW,
      TZ,
    );
    expect(flags.unbooked).toBe(false);
  });
});

describe("rosterNote", () => {
  const noteFor = (s: RosterStudent) => rosterNote(s, rosterFlags(s, NOW, TZ), NOW, TZ);

  it("says nothing about a healthy student", () => {
    expect(noteFor(student())).toBeNull();
  });

  it("says nothing when there is no package — the balance column already did", () => {
    expect(noteFor(student({ activePackage: null }))).toBeNull();
  });

  it("prefers an expiry that has passed over everything else", () => {
    const s = student({
      activePackage: { total: 8, left: 1, expiresAt: inDays(-2) },
      hasUpcomingClass: false,
    });
    expect(noteFor(s)).toEqual({ kind: "expired" });
  });

  it("prefers a near expiry over an empty calendar", () => {
    const s = student({
      activePackage: { total: 8, left: 1, expiresAt: inDays(3) },
      hasUpcomingClass: false,
    });
    expect(noteFor(s)).toEqual({ kind: "expiringSoon", days: 3 });
  });

  it("says nothing extra about a low balance — the balance column already did", () => {
    // The chip would be the same sentence twice, next to a column reading
    // "1 left" in a warning tone.
    const s = student({ activePackage: { total: 8, left: 1, expiresAt: null } });
    expect(noteFor(s)).toBeNull();
  });

  it("reports the empty calendar on a student who is otherwise running low", () => {
    const s = student({
      activePackage: { total: 8, left: 1, expiresAt: null },
      hasUpcomingClass: false,
    });
    expect(noteFor(s)).toEqual({ kind: "unbooked" });
  });

  it("falls through to the empty calendar when the package is otherwise fine", () => {
    expect(noteFor(student({ hasUpcomingClass: false }))).toEqual({ kind: "unbooked" });
  });
});

describe("compareRoster", () => {
  const mira = student({ studentId: "a", name: "Mira", linkedAt: new Date("2026-01-01") });
  const bea = student({
    studentId: "b",
    name: "Bea",
    linkedAt: new Date("2026-06-01"),
    activePackage: { total: 8, left: 1, expiresAt: null },
  });
  const nadie = student({
    studentId: "c",
    name: "Nadie",
    linkedAt: new Date("2026-07-01"),
    activePackage: null,
  });
  const names = (rows: RosterStudent[]) => rows.map((r) => r.name);

  it("puts the newest pairing first by default", () => {
    expect(names([mira, bea, nadie].sort(compareRoster("recent", "en")))).toEqual([
      "Nadie",
      "Bea",
      "Mira",
    ]);
  });

  it("sorts A–Z in the reader's own language", () => {
    const pena = student({ studentId: "d", name: "Peña" });
    const pozo = student({ studentId: "e", name: "Pozo" });
    // Spanish puts "ñ" after "n", which is not where its code point sits.
    expect(names([pozo, pena].sort(compareRoster("name", "es-MX")))).toEqual(["Peña", "Pozo"]);
  });

  it("floats the emptiest balances to the top, students with nothing first", () => {
    expect(names([mira, bea, nadie].sort(compareRoster("balance", "en")))).toEqual([
      "Nadie",
      "Bea",
      "Mira",
    ]);
  });

  it("is a total order — a tie falls back to the name", () => {
    const one = student({ studentId: "1", name: "Zoe", linkedAt: new Date("2026-03-01") });
    const two = student({ studentId: "2", name: "Abel", linkedAt: new Date("2026-03-01") });
    expect(names([one, two].sort(compareRoster("recent", "en")))).toEqual(["Abel", "Zoe"]);
    expect(names([two, one].sort(compareRoster("recent", "en")))).toEqual(["Abel", "Zoe"]);
  });
});
