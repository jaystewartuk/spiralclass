// Small helpers for rendering UTC `timestamptz` values in a target IANA zone.
// Used by the student portal + booking confirmation where we always show
// the teacher's local time, plus the student's browser time when known.

import {
  DEFAULT_LOCALE,
  formatTimeInZone,
  timeOptionsFor,
  getDualZoneTime,
  formatDualZoneText,
  type TimeZoneParty,
  type DualZoneTime,
  type TFunction,
  usesEnglishCopy,
} from "@spiralclass/shared";

export type { TimeZoneParty, DualZoneTime };
export { getDualZoneTime, formatDualZoneText };

/**
 * Dual-timezone display standard for booking list rows (BookingCard's
 * `when`/`whenSecondary` props): the VIEWER's own local time is primary,
 * the other participant's local time is secondary — always both, even when
 * the two zones match (see packages/shared/src/dual-zone.ts). Callers
 * resolve which side is "viewer" (the page's own logged-in role) vs
 * "other" before calling — this function has no notion of teacher/student.
 */
export function bookingWhen(
  scheduledStart: Date,
  viewerTz: string,
  other: { tz: string; label: string },
  locale: string,
  t: TFunction,
): { when: string; whenSecondary: string } {
  const dz = getDualZoneTime(
    scheduledStart,
    { tz: viewerTz, label: t("web.dualZone.yourTime") },
    other,
    locale,
  );
  return {
    when: `${dz.viewer.dateLabel}, ${dz.viewer.timeLabel}`,
    whenSecondary: t("web.dualZone.otherPartyTime", {
      name: dz.other.label,
      time: `${dz.other.dateLabel}, ${dz.other.timeLabel} (${dz.other.tzDisplay})`,
    }),
  };
}

export function formatZonedDateTime(d: Date, tz: string, locale: string = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    ...timeOptionsFor(locale),
  }).format(d);
}

export function formatZonedTime(d: Date, tz: string, locale: string = DEFAULT_LOCALE): string {
  return formatTimeInZone(d, tz, locale);
}

/**
 * A date with no time and no weekday, in a target zone — "3 Oct 2026".
 *
 * For a fact whose YEAR matters and whose hour does not: a package expiry, a
 * grandfathered price's date. The student detail page was rendering exactly
 * this with `expiresAt.toISOString().slice(0, 10)`, which is neither localized
 * nor zoned — a package expiring at 23:00 in Mexico City printed the following
 * day's ISO date, and printed it as `2026-10-03` to a reader whose every other
 * date on the page was words.
 *
 * `dateStyle: "medium"` rather than hand-picked parts, so a locale that orders
 * or abbreviates differently gets its own answer rather than an English one
 * with translated month names.
 */
export function formatZonedDateCompact(
  d: Date,
  tz: string,
  locale: string = DEFAULT_LOCALE,
): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, dateStyle: "medium" }).format(d);
}

export function formatZonedDate(d: Date, tz: string, locale: string = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

/**
 * Upper-case the FIRST letter of a formatted date, and only that one.
 *
 * The CSS answer — `className="capitalize"` — title-cases every word, so
 * "jueves, 12 de junio de 2026" renders as "Jueves, 12 De Junio De 2026" and
 * "jeudi 12 juin 2026" as "Jeudi 12 Juin 2026". English hid the bug: its
 * `weekday: "long"` output is already capitalised and the rest of the phrase
 * is a number and a capitalised month, so the transform was a no-op there and
 * nowhere else.
 *
 * `toLocaleUpperCase(locale)` rather than `toUpperCase()`, because the mapping
 * is language-dependent — Turkish dotless i being the standard example. Not a
 * locale this app registers today, and exactly the kind of thing that should
 * not need revisiting when it is.
 */
export function capitalizeFirst(text: string, locale: string): string {
  if (!text) return text;
  const [first] = text;
  return first.toLocaleUpperCase(locale) + text.slice(first.length);
}

/**
 * The human half of an IANA zone id: `America/Mexico_City` → "Mexico City".
 *
 * `teachers.timezone` holds a machine identifier, and screens were printing it
 * verbatim as product copy — the dashboard's only subtitle was the literal
 * string `America/Mexico_City`. The zone still has to be NAMED (this product
 * shows two parties' clocks and the caveat is load-bearing), so the fix is to
 * say it the way a person would rather than to hide it.
 *
 * The last path segment is the locality in every IANA id, including the
 * three-part ones (`America/Argentina/Buenos_Aires` → "Buenos Aires"), and the
 * segment-free ids (`UTC`) pass through unchanged.
 */
export function timezoneCityLabel(tz: string): string {
  const segment = tz.split("/").pop() ?? tz;
  return segment.replace(/_/g, " ");
}

// Day-group header for class list pages (e.g. "Friday, July 3") — like
// formatZonedDate but drops the year.
/**
 * A date at its shortest that is still unambiguous — `12 Aug`, and
 * `12 Aug 2025` once the year stops being obvious.
 *
 * For a dense meta line, where the weekday and full month name
 * `formatZonedDayHeader` prints are more than the line can carry. The year
 * appears only when the date falls outside `now`'s year, because "2026" on
 * every row in 2026 is noise, while a bare "12 Aug" on a class from two years
 * ago is a genuine misreading.
 *
 * `locale` is required rather than defaulted. The other helpers here default to
 * `DEFAULT_LOCALE`, which is the right answer for a caller that genuinely has
 * no locale — but a caller that simply forgot to thread one through gets the
 * same answer silently, and a date is exactly where that goes unnoticed.
 */
export function formatZonedShortDate(
  d: Date,
  tz: string,
  locale: string,
  now: Date = new Date(),
): string {
  const yearIn = (value: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric" }).format(value);
  const sameYear = yearIn(d) === yearIn(now);
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(d);
}

export function formatZonedDayHeader(d: Date, tz: string, locale: string = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(d);
}

// @deprecated teacher-primary/student-secondary is wrong for a student
// viewer — use getDualZoneTime(d, viewer, other) instead, which puts
// whoever is currently looking at the page first. Kept only for call
// sites not yet migrated; do not add new usages.
export function formatBothZones(
  d: Date,
  teacherTz: string,
  studentTz: string | null | undefined,
  locale: string = DEFAULT_LOCALE,
): string {
  const teacherStr = formatZonedDateTime(d, teacherTz, locale);
  if (!studentTz || studentTz === teacherTz) return teacherStr;
  const studentStr = formatZonedDateTime(d, studentTz, locale);
  if (studentStr === teacherStr) return teacherStr;
  const yourZone = usesEnglishCopy(locale) ? "your zone" : "tu zona";
  return `${teacherStr} · ${studentStr} (${yourZone})`;
}

// ---------------------------------------------------------------------------
// "What time is it there, right now"
// ---------------------------------------------------------------------------
//
// The dual-zone helpers above render a SCHEDULED instant — a class at 4pm. A
// student looking at their teacher's profile is asking a different question
// before they hit "message": is it a reasonable hour where she is? That needs
// the same instant (now) rendered in two zones, plus the one fact a single
// clock face cannot carry — that the two are not on the same calendar day.
//
// Both helpers are pure and take `at` explicitly rather than reading the clock,
// so the server render and the client tick that replaces it produce identical
// output for the same instant, and so the tests can pin one.

/** Calendar-date parts of an instant in a zone. */
function zonedDateParts(at: Date, tz: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

export type ZoneNow = {
  /** Wall-clock time in the zone, in the viewer's locale: "4:32 PM" / "16:32". */
  time: string;
  /** The zone's calendar date, short: "Wed, 3 Sep". */
  date: string;
  /** The zone's locality, as a person would say it: "Mexico City". */
  city: string;
  /** Sortable/comparable calendar date — compare two of these, never `date`. */
  ymd: string;
};

/** One zone's clock face at `at`, ready to render. */
export function zoneNow(at: Date, tz: string, locale: string): ZoneNow {
  const { year, month, day } = zonedDateParts(at, tz);
  return {
    time: formatZonedTime(at, tz, locale),
    date: new Intl.DateTimeFormat(locale, {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(at),
    city: timezoneCityLabel(tz),
    ymd: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/**
 * Whether two zones read the SAME wall clock at this instant.
 *
 * Compared as rendered clocks rather than as IANA ids, because the ids are not
 * the question: Europe/London and Europe/Lisbon are two ids and one clock, and
 * a student in Lisbon looking at a London teacher does not need two identical
 * clock faces labelled differently. Compared as rendered clocks rather than as
 * UTC offsets too, because "would these two read the same?" is literally what
 * is being asked, and an offset probe has to name an hour style to answer it —
 * the one thing `timeOptionsFor` exists to keep out of call sites.
 */
export function sameWallClock(a: ZoneNow, b: ZoneNow): boolean {
  return a.time === b.time && a.ymd === b.ymd;
}
