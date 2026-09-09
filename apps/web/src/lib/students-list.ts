/**
 * The decisions the teacher roster makes before it renders anything.
 *
 * Kept pure and out of the page so they are unit-testable, in the same shape
 * as lib/classes-list.ts: which view is being asked for, how it is sorted,
 * what the search box actually searched for, and — the part this file exists
 * for — what is WRONG with a given student, if anything.
 *
 * That last one is the whole difference between a roster and a list of names.
 * A teacher does not open this screen to read twelve names she already knows;
 * she opens it to find the two people who need something from her. The page
 * owns the queries and the markup; none of this is decided there.
 */

import { toYMD } from "@/lib/tz";

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * The three views of the roster.
 *
 * `active` is named for what it CONTAINS rather than "all": it excludes
 * archived students, and calling that "All" beside a separate "Archived" tab
 * would be a claim the list does not honour.
 */
export const STUDENT_SCOPES = ["active", "attention", "archived"] as const;
export type StudentScope = (typeof STUDENT_SCOPES)[number];

export const DEFAULT_STUDENT_SCOPE: StudentScope = "active";

/**
 * A `?show=` value from the URL, narrowed. Anything unrecognised falls back to
 * the default rather than 404ing: this parameter is a view preference, and a
 * stale bookmark should still show the teacher her students.
 */
export function resolveStudentScope(raw: string | string[] | undefined): StudentScope {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (STUDENT_SCOPES as readonly string[]).includes(value ?? "")
    ? (value as StudentScope)
    : DEFAULT_STUDENT_SCOPE;
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/**
 * How the roster is ordered.
 *
 * `recent` is the order the screen has always used (newest pairing first) and
 * stays the default so an existing bookmark lands where it did. `balance` is
 * the one that does work: fewest classes left first, which floats the students
 * about to run out to the top without her having to read every row.
 */
export const STUDENT_SORTS = ["recent", "name", "balance"] as const;
export type StudentSort = (typeof STUDENT_SORTS)[number];

export const DEFAULT_STUDENT_SORT: StudentSort = "recent";

export function resolveStudentSort(raw: string | string[] | undefined): StudentSort {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (STUDENT_SORTS as readonly string[]).includes(value ?? "")
    ? (value as StudentSort)
    : DEFAULT_STUDENT_SORT;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * The longest search term the page will act on. No student name, email or
 * phone number is anywhere near this long, and an unbounded string is an
 * unbounded scan of every row.
 */
export const STUDENT_SEARCH_MAX_LENGTH = 60;

/**
 * A `?q=` value from the URL, normalised. Returns an empty string for "no
 * search", so the caller has one falsy check rather than an undefined/empty
 * distinction that means nothing to it.
 */
export function normalizeStudentSearch(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? "").trim().slice(0, STUDENT_SEARCH_MAX_LENGTH);
}

/**
 * Casefold and strip diacritics, so "lopez" finds "López".
 *
 * This is why the roster is searched in memory rather than with a Prisma
 * `contains` filter. Postgres `ILIKE` folds case and nothing else, so on a
 * product whose students are named López, Peña, Nuñez and Müller the obvious
 * server-side search silently fails for exactly the people it is for — and
 * fails SILENTLY, returning "no students found" rather than an error. The
 * roster is tens of rows; folding them is free.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** The fields a search looks at — name, email and phone, in that order. */
export interface StudentSearchable {
  name: string;
  email: string | null;
  phoneE164: string | null;
}

export function matchesStudentSearch(row: StudentSearchable, term: string): boolean {
  if (!term) return true;
  const needle = foldForSearch(term);
  // Digits only for the phone, so "55 1234" matches a stored "+525512345678"
  // — nobody types a number back the way E.164 stores it.
  const digits = needle.replace(/\D/g, "");
  return (
    foldForSearch(row.name).includes(needle) ||
    (row.email != null && foldForSearch(row.email).includes(needle)) ||
    (digits.length > 0 && row.phoneE164 != null && row.phoneE164.includes(digits))
  );
}

/** The canonical URL for a view of the roster, so no call site builds one by hand. */
export function studentsHref(
  scope: StudentScope,
  opts: { search?: string; sort?: StudentSort } = {},
): string {
  const params = new URLSearchParams();
  if (scope !== DEFAULT_STUDENT_SCOPE) params.set("show", scope);
  if (opts.search) params.set("q", opts.search);
  if (opts.sort && opts.sort !== DEFAULT_STUDENT_SORT) params.set("sort", opts.sort);
  const query = params.toString();
  return query ? `/dashboard/students?${query}` : "/dashboard/students";
}

// ---------------------------------------------------------------------------
// What needs attention
// ---------------------------------------------------------------------------

/**
 * At or below this many classes left to teach, a package is "running out".
 *
 * Two rather than one because one is already too late: a teacher who finds out
 * at the last class has no room to have the conversation before it, and the
 * renewal conversation is the whole point of the signal.
 */
export const LOW_BALANCE_CLASSES = 2;

/** How near an expiry has to be before the roster says so. */
export const EXPIRING_SOON_DAYS = 14;

/**
 * A roster row, reduced to what the decisions below actually read.
 *
 * `left` is classes LEFT TO TEACH (lib/package-usage.ts), not
 * `classesTotal - classesUsed` — the two differ by the still-scheduled
 * bookings, and only the first is the number the teacher tracks.
 */
export interface RosterStudent {
  studentId: string;
  name: string;
  email: string | null;
  phoneE164: string | null;
  /** When this student joined THIS teacher's roster — the `recent` order. */
  linkedAt: Date;
  archived: boolean;
  /** Staged silently: she has to go live before the student hears anything. */
  notLive: boolean;
  levelLabel: string | null;
  /** How many packages this student has an agreed (grandfathered) price for. */
  agreedPriceCount: number;
  activePackage: { total: number; left: number; expiresAt: Date | null } | null;
  /** Whether a class with this teacher is on the calendar ahead of now. */
  hasUpcomingClass: boolean;
}

export interface RosterFlags {
  notLive: boolean;
  /** On the roster with nothing to teach — the renewal conversation. */
  noPackage: boolean;
  expired: boolean;
  expiringSoon: boolean;
  /** Classes left, but nothing on the calendar. The quiet way a student goes. */
  unbooked: boolean;
  lowBalance: boolean;
}

/**
 * Calendar days from now until a date, in the teacher's own zone.
 *
 * CALENDAR days, not a division by 86,400,000: "expires tomorrow" is a fact
 * about her wall clock, and a package expiring at 09:00 tomorrow is one day
 * away at midnight tonight and one day away at 08:00 tomorrow. A duration
 * would call the first 0 and the second 0 as well, having been 1 in between.
 * Negative means it has already passed.
 */
export function calendarDaysUntil(target: Date, now: Date, timezone: string): number {
  const asUtcMidnight = (d: Date) => Date.parse(`${toYMD(d, timezone)}T00:00:00Z`);
  return Math.round((asUtcMidnight(target) - asUtcMidnight(now)) / 86_400_000);
}

export function rosterFlags(student: RosterStudent, now: Date, timezone: string): RosterFlags {
  const pkg = student.activePackage;
  const daysToExpiry =
    pkg?.expiresAt != null ? calendarDaysUntil(pkg.expiresAt, now, timezone) : null;

  // A package with no classes left is spent, not "running low" — it is the
  // same conversation as having no package at all, and saying both about one
  // row would be two chips for one fact.
  const spent = pkg != null && pkg.left <= 0;

  return {
    notLive: student.notLive,
    noPackage: pkg == null || spent,
    expired: daysToExpiry != null && daysToExpiry < 0,
    expiringSoon: daysToExpiry != null && daysToExpiry >= 0 && daysToExpiry <= EXPIRING_SOON_DAYS,
    unbooked: pkg != null && !spent && !student.hasUpcomingClass,
    lowBalance: pkg != null && !spent && pkg.left <= LOW_BALANCE_CLASSES,
  };
}

/**
 * Whether this row belongs in the "Needs attention" view.
 *
 * An expiry that is still weeks out on a package she has barely started is
 * NOT attention — `expiringSoon` only counts once it is inside the window,
 * which is what that flag already means. An archived student needs nothing by
 * definition and is filtered out before this is asked.
 */
export function needsAttention(flags: RosterFlags): boolean {
  return (
    flags.notLive ||
    flags.noPackage ||
    flags.expired ||
    flags.expiringSoon ||
    flags.unbooked ||
    flags.lowBalance
  );
}

/**
 * The ONE thing the row says about this student's package, chosen by urgency.
 *
 * Returned as a discriminated union rather than a string so the caller keeps
 * its own `t` and this file stays free of the i18n runtime — the same contract
 * `proximityLabel` in classes-list.ts uses.
 *
 * One, not all of them. A row that says "expiring", "running low" AND "no
 * class booked" has told her three symptoms of a single situation and left her
 * to work out which one to act on; the most urgent is the only one that
 * changes what she does next.
 *
 * A LOW BALANCE IS DELIBERATELY NOT ONE OF THEM. The balance column beside the
 * chip already reads "2 left", in a warning tone — a chip saying "2 classes
 * left" next to it is the same sentence twice, and it would crowd out the one
 * fact the column cannot show. The tone is reinforcement; the number is what
 * carries the meaning, so nothing here depends on colour alone.
 */
export type RosterNote =
  { kind: "expired" } | { kind: "expiringSoon"; days: number } | { kind: "unbooked" } | null;

export function rosterNote(
  student: RosterStudent,
  flags: RosterFlags,
  now: Date,
  timezone: string,
): RosterNote {
  // No package at all is already stated by the balance column ("No active
  // package"), so there is nothing left for a chip to add.
  if (flags.noPackage) return null;
  if (flags.expired) return { kind: "expired" };
  if (flags.expiringSoon && student.activePackage?.expiresAt != null) {
    return {
      kind: "expiringSoon",
      days: calendarDaysUntil(student.activePackage.expiresAt, now, timezone),
    };
  }
  if (flags.unbooked) return { kind: "unbooked" };
  return null;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * The comparator for a chosen order.
 *
 * `locale` is passed to `localeCompare` because A–Z is not the same question
 * in every language this app ships in — Spanish sorts "ñ" after "n" rather
 * than wherever its code point lands, and a roster of Peñas ordered by code
 * point is a roster ordered by nothing a reader can see.
 *
 * Every comparator falls back to name, so the order is TOTAL: two students
 * with three classes left keep a stable, meaningful position between renders
 * rather than swapping places because the database returned them differently.
 */
export function compareRoster(
  sort: StudentSort,
  locale: string,
): (a: RosterStudent, b: RosterStudent) => number {
  const byName = (a: RosterStudent, b: RosterStudent) =>
    a.name.localeCompare(b.name, locale, { sensitivity: "base" });

  if (sort === "name") return byName;

  if (sort === "balance") {
    return (a, b) => {
      // A student with no active package sorts as EMPTIEST, not as unknown:
      // "fewest classes left" is a question she asks to find who to talk to,
      // and someone with nothing left is the most overdue conversation on the
      // list. Sinking them to the bottom would hide the answer under the rows
      // that still have credit.
      const left = (s: RosterStudent) => s.activePackage?.left ?? -1;
      return left(a) - left(b) || byName(a, b);
    };
  }

  return (a, b) => b.linkedAt.getTime() - a.linkedAt.getTime() || byName(a, b);
}
