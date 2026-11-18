/**
 * The decisions the teacher class list makes before it renders anything.
 *
 * Kept pure and out of the page so they are unit-testable: which of the three
 * views is being asked for, what the search box actually searched for, which
 * student the list is narrowed to, and where a class sits relative to right
 * now. The page owns the queries and the
 * markup; none of that is decided here.
 */

/**
 * The three views of the roster.
 *
 * `materials` is a filter rather than a time range — it is the same upcoming
 * set narrowed to the classes with nothing attached yet — but it behaves like
 * a scope from the reader's side (it replaces the list), so it lives in the
 * same union rather than as a second orthogonal parameter nobody would think
 * to combine.
 */
export const CLASSES_SCOPES = ["upcoming", "materials", "past"] as const;
export type ClassesScope = (typeof CLASSES_SCOPES)[number];

export const DEFAULT_CLASSES_SCOPE: ClassesScope = "upcoming";

/**
 * A `?show=` value from the URL, narrowed. Anything unrecognised falls back to
 * the default rather than 404ing: this parameter is a view preference, and a
 * stale or hand-edited link should still show the teacher her classes.
 */
export function resolveClassesScope(raw: string | string[] | undefined): ClassesScope {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (CLASSES_SCOPES as readonly string[]).includes(value ?? "")
    ? (value as ClassesScope)
    : DEFAULT_CLASSES_SCOPE;
}

/**
 * The longest search term the page will act on. Not a security boundary —
 * Prisma parameterises the value — but an unbounded string in a `contains`
 * filter is an unbounded scan, and no student name is anywhere near this long.
 */
export const CLASS_SEARCH_MAX_LENGTH = 60;

/**
 * A `?q=` value from the URL, normalised. Returns an empty string for "no
 * search", so the caller has one falsy check rather than an undefined/empty
 * distinction that means nothing to it.
 */
export function normalizeClassSearch(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? "").trim().slice(0, CLASS_SEARCH_MAX_LENGTH);
}

/** The shape of a student id (a Postgres uuid). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A `?student=` value from the URL, narrowed to something shaped like a
 * student id, or an empty string for "every student".
 *
 * This only checks the shape. The page still looks the id up on the
 * teacher's own roster before it filters by it, and ignores an id that is not
 * there. Checking the shape first keeps a hand-edited value from reaching a
 * uuid column, where Postgres would throw instead of matching nothing.
 */
export function normalizeClassStudent(raw: string | string[] | undefined): string {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  return UUID_PATTERN.test(value) ? value.toLowerCase() : "";
}

/**
 * The canonical URL for a view of the list, so no call site builds one by hand.
 *
 * `student` narrows any view to one student's classes. It is the link the
 * student page's "All classes" follows, so that link shows that student's
 * classes and nobody else's.
 */
export function classesHref(scope: ClassesScope, search = "", student = ""): string {
  const params = new URLSearchParams();
  if (scope !== DEFAULT_CLASSES_SCOPE) params.set("show", scope);
  if (search) params.set("q", search);
  if (student) params.set("student", student);
  const query = params.toString();
  return query ? `/dashboard/classes?${query}` : "/dashboard/classes";
}

/**
 * Where a class sits relative to now.
 *
 * `live` is the interval the class is actually running in — the teacher's cue
 * to join rather than to read. `soon` and `later` are both future; the split
 * exists because a countdown is only worth printing while it is short enough
 * to act on, and "starts in 9 days" is noise on a row that already says which
 * day it is.
 */
export type ClassProximity =
  { state: "live" } | { state: "soon"; minutes: number } | { state: "later" };

/**
 * How far ahead a class still counts as "soon". Two hours is the window in
 * which a teacher is plausibly preparing for it rather than planning around
 * it, and it keeps the countdown to at most a two-digit number of minutes or a
 * single hour figure.
 */
export const SOON_WINDOW_MINUTES = 120;

export function classProximity(start: Date, end: Date, now: Date): ClassProximity {
  if (start <= now && now < end) return { state: "live" };
  const minutes = Math.round((start.getTime() - now.getTime()) / 60_000);
  if (minutes >= 0 && minutes <= SOON_WINDOW_MINUTES) return { state: "soon", minutes };
  return { state: "later" };
}

/**
 * The countdown a `soon` class prints, as a catalog key plus its variables.
 *
 * Returned rather than rendered so this stays free of the i18n runtime and the
 * caller keeps the one `t` it already has. Minutes below one resolve to
 * "Starting now": a class 40 seconds out is not usefully "in 0 min", and the
 * rounding above can land there while the class has genuinely not begun.
 */
export function proximityLabel(proximity: ClassProximity): {
  key: "classes.relative.now" | "classes.relative.minutes" | "classes.relative.hours";
  vars?: { n: number };
} | null {
  if (proximity.state !== "soon") return null;
  if (proximity.minutes < 1) return { key: "classes.relative.now" };
  if (proximity.minutes < 60)
    return { key: "classes.relative.minutes", vars: { n: proximity.minutes } };
  // FLOORED, not rounded. A countdown that rounds up tells someone with 95
  // minutes that she has two hours, and the cost of the two errors is not
  // symmetric: understating leaves her early, overstating makes her late.
  return { key: "classes.relative.hours", vars: { n: Math.floor(proximity.minutes / 60) } };
}
