// How an hour is written, per locale — the one place that decides it.
//
// WHY THIS EXISTS. "Should the hour carry a leading zero?" was being answered
// independently at sixteen call sites across web, mobile and this package, and
// they did not agree: eleven said `hour: "2-digit"` and four said `numeric`.
// The product shipped both answers at once — the public checkout rendered
// "5:00 PM" while the teacher's own calendar rendered "05:00 PM" for the same
// class. Neither is wrong on its own; having both is.
//
// THE RULE, and it is a rule rather than a preference, because it follows from
// what each clock actually needs:
//
//   * A 24-HOUR locale keeps the leading zero. There is no meridiem, so the
//     zero costs nothing in width, and it buys the thing a schedule depends
//     on: `09:00` and `17:00` are the same number of characters, so a column
//     of times — the time grid's hour gutter, an agenda's left rail, a table —
//     lines up. Dropping it there would be a regression, not a tidy-up.
//
//   * A 12-HOUR locale drops it. `05:00 p.m.` is not how anyone writes five in
//     the afternoon, and the meridiem has already spent four characters that a
//     month-grid cell has to find room for beside a student's name. Width is
//     scarce exactly where the leading zero is least useful.
//
// WHICH LOCALE IS WHICH IS MEASURED, NOT LISTED, and that is the load-bearing
// part. Of the three locales in the registry, the 24-hour one is `fr`; `en-US`
// and — the one people get wrong from memory, including the author of the
// first draft of this file — `es-MX` are both twelve-hour. CLDR puts Mexico on
// h12: it writes "5:00 p.m.", not "17:00". A hardcoded list would have been
// wrong on the locale the platform's only Spanish-reading teacher actually
// uses, and wrong invisibly.
//
// So the answer is derived from the locale, never passed in — a caller that
// could choose is a caller that could choose differently from the next one,
// which is how the sixteen answers happened.

/** A Tuesday afternoon in UTC. Any instant works; this one is in the PM half
 * of the day, so a 12-hour locale must emit a `dayPeriod` part for it. */
const PROBE = new Date("2026-01-06T13:00:00.000Z");

/**
 * Detected by asking Intl for a `dayPeriod` part rather than by reading
 * `resolvedOptions().hourCycle`.
 *
 * Both would work in Node and in every current browser. `formatToParts` also
 * works under Hermes, whose `Intl` is a partial implementation and does not
 * reliably report `hourCycle` — and this module is in `packages/shared`, which
 * both clients consume, so the detection has to hold on the narrower runtime.
 * A locale that prints "PM" is a locale that counts to twelve; nothing else
 * needs to be known.
 */
const HOUR_STYLE = new Map<string, "numeric" | "2-digit">();

export function hourStyleFor(locale: string): "numeric" | "2-digit" {
  const cached = HOUR_STYLE.get(locale);
  if (cached) return cached;
  let style: "numeric" | "2-digit" = "2-digit";
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      hour: "numeric",
      minute: "2-digit",
    }).formatToParts(PROBE);
    if (parts.some((p) => p.type === "dayPeriod")) style = "numeric";
  } catch {
    // An unrecognised locale tag, or an Intl too small to answer. Falling back
    // to `2-digit` reproduces what every call site did before this module, so
    // a runtime that cannot detect renders exactly as it always has rather
    // than differently-and-silently.
  }
  HOUR_STYLE.set(locale, style);
  return style;
}

/**
 * The `hour`/`minute` half of an `Intl.DateTimeFormat` options bag, resolved
 * for the locale. Spread it into a larger options object when a formatter also
 * wants a weekday or a date:
 *
 *   new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", ...timeOptionsFor(locale) })
 */
export function timeOptionsFor(
  locale: string,
): Pick<Intl.DateTimeFormatOptions, "hour" | "minute"> {
  return { hour: hourStyleFor(locale), minute: "2-digit" };
}

/** A wall-clock time in an IANA zone: "17:00", or "5:00 PM". */
export function formatTimeInZone(d: Date, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, ...timeOptionsFor(locale) }).format(d);
}

/** Test seam — the memo is per-process and would otherwise outlive a test that
 * stubs Intl. Not used by the app. */
export function __resetHourStyleCache(): void {
  HOUR_STYLE.clear();
}
