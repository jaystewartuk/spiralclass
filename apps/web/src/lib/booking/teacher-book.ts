// The pure decisions behind the teacher's self-serve booking screen
// (`/dashboard/classes/book`), kept out of the page so each one can be tested
// without a database, a request or a clock.
//
// Nothing here formats anything or reads a timezone by itself: the caller
// resolves an instant to an hour in whichever zone it is displaying, and passes
// that in. Two zones are in play on this screen — hers and the student's — and
// a helper that picked one of them would be picking it for every caller.

import { isValidYmd } from "@/lib/calendar-grid";

/**
 * The three bands a day's open times are grouped into.
 *
 * A teacher's day produces twenty-odd slots at a 30-minute granularity, and a
 * flat grid of twenty identical buttons is read by scanning every one of them.
 * The bands exist so that "she asked for something after work" is one glance
 * rather than twenty comparisons — the same reason every calendar product
 * groups them.
 *
 * The boundaries are the ordinary ones and are deliberately NOT configurable:
 * this is a reading aid for a list she already sees in full, not a filter, so
 * a wrong-by-an-hour boundary costs nothing and a per-teacher setting would
 * cost a column, a form and a migration.
 */
export const DAY_PARTS = ["morning", "afternoon", "evening"] as const;
export type DayPart = (typeof DAY_PARTS)[number];

/** Noon and 5pm, as hours in the zone the slots are being read in. */
const AFTERNOON_FROM = 12;
const EVENING_FROM = 17;

export function dayPartOf(hour: number): DayPart {
  if (hour < AFTERNOON_FROM) return "morning";
  if (hour < EVENING_FROM) return "afternoon";
  return "evening";
}

/**
 * Group slots into the day's bands, preserving order and **dropping empty
 * bands**. A heading over nothing is furniture, and a teacher who works
 * mornings only would otherwise get two of them on every load.
 */
export function groupSlotsByDayPart<T>(
  slots: readonly T[],
  hourOf: (slot: T) => number,
): Array<{ part: DayPart; slots: T[] }> {
  const buckets = new Map<DayPart, T[]>();
  for (const slot of slots) {
    const part = dayPartOf(hourOf(slot));
    const bucket = buckets.get(part);
    if (bucket) bucket.push(slot);
    else buckets.set(part, [slot]);
  }
  return DAY_PARTS.filter((part) => buckets.has(part)).map((part) => ({
    part,
    slots: buckets.get(part)!,
  }));
}

/**
 * Resolve the `?date=` param to a day inside the bookable window.
 *
 * The previous version clamped the raw string, which meant a param that was
 * not a date at all still landed somewhere: `?date=zzz` compares greater than
 * every real `YYYY-MM-DD`, so it clamped to the LAST bookable day and the
 * teacher silently opened two months out. Anything that is not a genuine
 * calendar date is discarded here instead, and the caller falls back to its
 * own default.
 */
export function resolveBookableDay(
  raw: string | undefined,
  minYmd: string,
  maxYmd: string,
): string | null {
  if (!raw || !isValidYmd(raw)) return null;
  if (raw < minYmd) return minYmd;
  if (raw > maxYmd) return maxYmd;
  return raw;
}

/** One student on the picker, with the only fact that decides whether she can book. */
export type RosterEntry = {
  studentId: string;
  name: string;
  email: string | null;
  /** Classes across every active, unexpired package — what she can still book. */
  classesAvailable: number;
  /** Most recent link/activity, for ordering within a group. */
  sortDate: Date;
};

/**
 * Order the roster by what the screen is FOR.
 *
 * A booking screen's list is not a roster listing: a student with no classes
 * left cannot be booked, so she cannot be the first name under the cursor.
 * Bookable students come first, each group newest-first — which is the order
 * the old screen used for everyone, so a teacher who knew where a name was
 * still finds it there unless it was unbookable all along.
 */
export function orderRoster(entries: readonly RosterEntry[]): RosterEntry[] {
  return [...entries].sort((a, b) => {
    const aBookable = a.classesAvailable > 0;
    const bBookable = b.classesAvailable > 0;
    if (aBookable !== bBookable) return aBookable ? -1 : 1;
    return b.sortDate.getTime() - a.sortDate.getTime();
  });
}

/**
 * Filter the roster by a typed query.
 *
 * In memory rather than in SQL, and that is a bounded claim: this list is one
 * teacher's own students, already loaded in full to compute the per-student
 * class counts above. A `WHERE name ILIKE` would be a second round trip over
 * the same rows.
 */
export function filterRoster(entries: readonly RosterEntry[], query: string): RosterEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...entries];
  return entries.filter(
    (e) =>
      e.name.toLocaleLowerCase().includes(needle) ||
      (e.email ?? "").toLocaleLowerCase().includes(needle),
  );
}

/**
 * The roster size at which the search box appears.
 *
 * Below it, search is a control that costs a row of vertical space to save
 * nothing — every name is already on screen. Above it, the list is a scroll.
 */
export const ROSTER_SEARCH_THRESHOLD = 8;

/**
 * The canonical URL for a state of the booking screen, so no call site builds
 * a query string by hand.
 *
 * Every step of this flow is a URL — that is what makes the back button, a
 * bookmark and a middle-click work — and the old page assembled those URLs by
 * string concatenation in four places, one of which dropped the selected day
 * whenever the teacher changed package.
 */
export function bookHref(params: {
  studentId?: string;
  packageId?: string;
  date?: string;
  q?: string;
}): string {
  const search = new URLSearchParams();
  if (params.studentId) search.set("studentId", params.studentId);
  if (params.packageId) search.set("packageId", params.packageId);
  if (params.date) search.set("date", params.date);
  if (params.q) search.set("q", params.q);
  const query = search.toString();
  return query ? `/dashboard/classes/book?${query}` : "/dashboard/classes/book";
}

/** The longest roster query the picker acts on — see CLASS_SEARCH_MAX_LENGTH. */
export const ROSTER_SEARCH_MAX_LENGTH = 60;

/** A `?q=` value from the URL, normalised to "" for absent. */
export function normalizeRosterSearch(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? "").trim().slice(0, ROSTER_SEARCH_MAX_LENGTH);
}
