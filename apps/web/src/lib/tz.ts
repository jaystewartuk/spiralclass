// Shared timezone utilities. All timezone-aware calendar operations go here
// so slot generation, notifications, and any future features share one source
// of truth instead of each implementing their own Intl/date-fns-tz wrappers.

import { fromZonedTime } from "date-fns-tz";
import { DEFAULT_LOCALE, timeOptionsFor } from "@spiralclass/shared";

/** Build a UTC Date for (YYYY-MM-DD, HH:MM) in the given IANA zone. Handles DST. */
export function zonedWallClockToUtc(ymd: string, hhmm: string, tz: string): Date {
  return fromZonedTime(`${ymd}T${hhmm}:00`, tz);
}

/** Convert a UTC Date to a YYYY-MM-DD string in the given IANA zone. */
export function toYMD(d: Date, tz: string): string {
  // An invalid `tz` throws a RangeError here at construction — the caller is
  // expected to pass a validated IANA zone (see validators.isValidTimezone).
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  // No non-null assertion: if the platform's Intl ever omits a part, fail with
  // a descriptive error instead of a bare "cannot read property of undefined".
  const get = (t: string) => {
    const part = parts.find((p) => p.type === t);
    if (!part) throw new Error(`toYMD: missing "${t}" part for tz "${tz}"`);
    return part.value;
  };
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Return the weekday (0 = Sunday … 6 = Saturday) of a UTC Date in the given IANA zone. */
export function weekdayInZone(d: Date, tz: string): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).format(d);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[
    name as "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat"
  ];
}

/**
 * Normalise a date argument to YYYY-MM-DD in the given IANA zone.
 * Strings are returned as-is; Date objects are converted via toYMD.
 */
export function normalizeInputDate(date: Date | string, tz: string): string {
  if (typeof date === "string") return date;
  return toYMD(date, tz);
}

/** Two half-open intervals [aStart, aEnd) and [bStart, bEnd) overlap iff aStart < bEnd && bStart < aEnd. */
export function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Format a UTC Date as a human-readable date+time string in the teacher's
 * local timezone and locale. Defaults to es-MX (Mexico City) when no locale
 * is supplied, which matches the MVP teacher base.
 */
export function formatDateTimeInZone(d: Date, tz: string, locale: string = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    ...timeOptionsFor(locale),
  }).format(d);
}

/**
 * Format a UTC Date as a CALENDAR DATE in the teacher's zone and locale — no
 * weekday, no clock.
 *
 * Distinct from `formatDateTimeInZone` because a billing date is not an
 * appointment. Stripe renews at an arbitrary instant, so "Tuesday, 15 September
 * at 4:32 a.m." presents a precision the teacher can neither act on nor verify,
 * and reads as though she has to be somewhere. The year is included: a renewal
 * or a paid invoice is routinely more than a few months from today, which is
 * exactly where a bare day-and-month becomes ambiguous.
 */
export function formatDateInZone(d: Date, tz: string, locale: string = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}
