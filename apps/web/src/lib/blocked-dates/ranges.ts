// Calendar-date interval maths for the blocked-dates screen.
//
// Everything here works on plain `YYYY-MM-DD` strings — these are CALENDAR
// dates, not instants, so no timezone is involved (the page converts each
// stored `timestamptz` to a YMD in the teacher's zone once, on the server, and
// nothing downstream touches a Date). Lexicographic comparison on a zero-padded
// YMD is chronological comparison, which is why the predicates below are plain
// string comparisons.
//
// Nothing here EXPANDS a range into its days: a block may legitimately span a
// year, and the screen only ever needs to ask three questions of one — does it
// cover this cell, does it overlap this selection, and how many days is it.
// Interval arithmetic answers all three in constant time and cannot be made to
// allocate an unbounded array by a hand-typed `9999-12-31`.

import { shiftDay, ymdToUtcNoon } from "@/lib/calendar-grid";

/** An inclusive run of calendar days. `start <= end` always holds. */
export type DayRange = { start: string; end: string };

const MS_PER_DAY = 86_400_000;

/** Order two picked days into a range, whichever way round they were picked. */
export function normalizeRange(a: string, b: string): DayRange {
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/** Whether `ymd` falls inside the range (both ends inclusive). */
export function coversDay(range: DayRange, ymd: string): boolean {
  return ymd >= range.start && ymd <= range.end;
}

/** Whether two inclusive ranges share at least one day. */
export function rangesOverlap(a: DayRange, b: DayRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * Days in the range, counting both ends — a single day is 1, not 0.
 *
 * Pinned to noon UTC before subtracting so a DST transition inside the range
 * cannot round the division to the wrong integer; these are calendar dates and
 * a day is always one day long.
 */
export function rangeLength(range: DayRange): number {
  const ms = ymdToUtcNoon(range.end).getTime() - ymdToUtcNoon(range.start).getTime();
  return Math.round(ms / MS_PER_DAY) + 1;
}

/** The first range that covers `ymd`, or undefined — used to colour a cell and
 * to tell the teacher WHICH block a day belongs to rather than only that it is
 * blocked. */
export function rangeCovering<T extends DayRange>(
  ranges: readonly T[],
  ymd: string,
): T | undefined {
  return ranges.find((r) => coversDay(r, ymd));
}

/** How many of `ranges` overlap `range`. The bookings this screen counts are
 * distinct classes, so a class spanning midnight is counted once, not once per
 * day it touches. */
export function countOverlapping(ranges: readonly DayRange[], range: DayRange): number {
  return ranges.reduce((n, r) => (rangesOverlap(r, range) ? n + 1 : n), 0);
}

/**
 * Whether every day of `range` is already covered by `ranges` — including by
 * two adjacent blocks that only cover it between them.
 *
 * A sweep rather than a day-by-day set membership test, for the reason given at
 * the top of the file. Sorting by start makes one pass sufficient: once the
 * cursor has passed a block's end, no later block can fill a gap behind it.
 */
export function isFullyCovered(ranges: readonly DayRange[], range: DayRange): boolean {
  const relevant = ranges
    .filter((r) => rangesOverlap(r, range))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  let cursor = range.start;
  for (const r of relevant) {
    if (r.start > cursor) return false;
    if (r.end >= cursor) cursor = shiftDay(r.end, 1);
    if (cursor > range.end) return true;
  }
  return cursor > range.end;
}

/**
 * How many of `ranges` cover each day, keyed by YMD — the per-cell density the
 * calendar draws its "classes booked" dot from.
 *
 * `maxSpan` bounds the expansion. A booking is one class: same day, or two when
 * it runs past midnight. Anything longer is a data error, and expanding it
 * would be the one place on this screen where a bad row could allocate without
 * limit, so it is clamped rather than trusted.
 */
export function dayCounts(ranges: readonly DayRange[], maxSpan = 7): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of ranges) {
    let ymd = r.start;
    for (let i = 0; i < maxSpan && ymd <= r.end; i++) {
      counts.set(ymd, (counts.get(ymd) ?? 0) + 1);
      ymd = shiftDay(ymd, 1);
    }
  }
  return counts;
}
