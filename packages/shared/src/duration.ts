import { DEFAULT_LOCALE, intlLocale, matchAcceptLanguage } from "./i18n/locales";

// Durations in the reader's own unit format. They were a number with "min",
// "m" or "s" glued on in JSX, which is English's choice and nobody else's: a
// German reader writes "60 Min.", a Brazilian one "12 s". Measured: English
// and Spanish output is unchanged, and French reads the same with a no-break
// space between number and unit, as French typography sets it. `locale` is
// any stored tag; an unknown one reads as DEFAULT_LOCALE.

function unitFormatter(
  locale: string | null | undefined,
  unit: "minute" | "second",
  unitDisplay: "short" | "narrow",
): Intl.NumberFormat {
  const tag = intlLocale(matchAcceptLanguage(locale) ?? DEFAULT_LOCALE);
  return new Intl.NumberFormat(tag, { style: "unit", unit, unitDisplay });
}

/** A length in minutes: "60 min". */
export function formatMinutes(minutes: number, locale?: string | null): string {
  return unitFormatter(locale, "minute", "short").format(minutes);
}

/** A count of seconds in its narrowest form, for a running timer: "12s". */
export function formatSecondsNarrow(seconds: number, locale?: string | null): string {
  return unitFormatter(locale, "second", "narrow").format(seconds);
}
