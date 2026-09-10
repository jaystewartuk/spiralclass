// Dual-timezone display: every class-related date/time must show the
// viewer's own local time (primary) and the other participant's local
// time (secondary) — see docs/features (class scheduling) and D-NN dual
// timezone display. This is the single formatter web, mobile, and the
// notification dispatcher all build on, so "viewer primary / other
// secondary" is decided once here instead of per call site.
//
// Pure Intl.DateTimeFormat, no date-fns-tz dependency — IANA tz database
// resolution (incl. DST) is handled by the JS engine's ICU data.

import { formatTimeInZone, timeOptionsFor } from "./time-format";
import { DEFAULT_LOCALE } from "./i18n/locales";

// The zone to render an instant in when nothing better is known: no stored
// zone on the row, no device zone to read, nothing the viewer has chosen.
//
// UTC rather than a market's zone on purpose. Teachers and students are
// anywhere in the world, so any real zone picked as "the default" is wrong for
// most of them AND wrong invisibly — it renders a plausible wall-clock time
// that is simply not theirs. UTC is wrong for everyone, which is the point: it
// is the only value that cannot be mistaken for a resolved answer. Every
// display path should exhaust the viewer's own zone first (see
// `resolveDisplayZone` on mobile) and reach this only as a last resort.
export const FALLBACK_TIMEZONE = "UTC";

export interface TimeZoneParty {
  /** IANA zone, e.g. "America/Mexico_City". */
  tz: string;
  /** How to label this party in the secondary line, e.g. "Teacher", "Student". */
  label: string;
}

export interface ZonedMoment {
  /** IANA zone this moment was rendered in. */
  tz: string;
  /** e.g. "Today", "Fri, 3 Jul" — locale-formatted, relative-aware. */
  dateLabel: string;
  /** e.g. "4:00 PM". */
  timeLabel: string;
  /** Abbreviation if the platform's ICU data resolves one (e.g. "BST"); otherwise the IANA id. */
  tzDisplay: string;
}

export interface DualZoneTime {
  /** The viewer's own time — always render this as visually dominant. */
  viewer: ZonedMoment;
  /** The other participant's time — always render this as visually secondary, labeled. */
  other: ZonedMoment & { label: string };
  /** True when viewer and other resolve to the same wall-clock instant (still render both per spec). */
  sameWallClock: boolean;
  /** True when the calendar date differs between the two zones for this instant. */
  sameCalendarDate: boolean;
}

function partsOf(d: Date, tz: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    timeZoneName: "short",
    ...timeOptionsFor(locale),
  }).formatToParts(d);
}

function timeLabelOf(d: Date, tz: string, locale: string): string {
  return formatTimeInZone(d, tz, locale);
}

function tzDisplayOf(d: Date, tz: string, locale: string): string {
  const part = partsOf(d, tz, locale).find((p) => p.type === "timeZoneName");
  const value = part?.value ?? tz;
  // ICU sometimes has no real abbreviation and falls back to "GMT-6" /
  // "GMT+9" — ambiguous across zones sharing an offset, so prefer the
  // unambiguous full IANA id in that case (spec requirement).
  return /^GMT[+-]?\d*$/.test(value) ? tz : value;
}

function ymdOf(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * The two named days, per registered locale.
 *
 * A TABLE rather than the `locale.startsWith("es") ? … : …` ternaries this
 * replaces, because a two-branch ternary silently makes English the answer for
 * every locale that is not Spanish — which is how a French teacher's class list
 * printed "Today" above a row dated "jeudi 10 septembre". The same shape was
 * live in `booking-day-groups.ts` on web and said "Hoy" to her instead.
 *
 * English remains the fallback for an unregistered locale, matching
 * DEFAULT_LOCALE.
 */
const RELATIVE_DAYS: Record<string, { today: string; tomorrow: string }> = {
  es: { today: "Hoy", tomorrow: "Mañana" },
  fr: { today: "Aujourd'hui", tomorrow: "Demain" },
  en: { today: "Today", tomorrow: "Tomorrow" },
};

function relativeDays(locale: string) {
  return RELATIVE_DAYS[locale.slice(0, 2).toLowerCase()] ?? RELATIVE_DAYS.en;
}

/**
 * Relative-aware date label ("Today" / "Tomorrow" / weekday+date), computed
 * per-zone against `now` (also per-zone) so "today" reflects the zone being
 * rendered, not the server's or the viewer's clock.
 */
function dateLabelOf(d: Date, tz: string, locale: string, now: Date): string {
  const target = ymdOf(d, tz);
  const today = ymdOf(now, tz);
  const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrow = ymdOf(tomorrowDate, tz);
  if (target === today) return relativeDays(locale).today;
  if (target === tomorrow) return relativeDays(locale).tomorrow;
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(d);
}

function zonedMoment(d: Date, tz: string, locale: string, now: Date): ZonedMoment {
  return {
    tz,
    dateLabel: dateLabelOf(d, tz, locale, now),
    timeLabel: timeLabelOf(d, tz, locale),
    tzDisplay: tzDisplayOf(d, tz, locale),
  };
}

/**
 * Compute both parties' local rendering of a single UTC instant. Always
 * pass the CURRENT viewer as `viewer` — which physical person (teacher vs
 * student) that is changes per page load, never bake a role in here.
 */
export function getDualZoneTime(
  d: Date,
  viewer: TimeZoneParty,
  other: TimeZoneParty,
  locale: string = DEFAULT_LOCALE,
  now: Date = new Date(),
): DualZoneTime {
  const viewerMoment = zonedMoment(d, viewer.tz, locale, now);
  const otherMoment = zonedMoment(d, other.tz, locale, now);
  return {
    viewer: viewerMoment,
    other: { ...otherMoment, label: other.label },
    sameWallClock: viewerMoment.timeLabel === otherMoment.timeLabel && viewer.tz === other.tz,
    sameCalendarDate: ymdOf(d, viewer.tz) === ymdOf(d, other.tz),
  };
}

/** Whose clock each line of the plaintext rendering belongs to. */
const OWNER_LABELS: Record<string, { yours: string; theirs: (name: string) => string }> = {
  es: { yours: "Tu hora", theirs: (name) => `Hora de ${name}` },
  fr: { yours: "Votre heure", theirs: (name) => `Heure de ${name}` },
  en: { yours: "Your time", theirs: (name) => `${name}'s time` },
};

/**
 * Plaintext rendering for surfaces that can't do two-tier visual layout
 * (emails' plaintext part, SMS, push notification body, system chat
 * messages, ICS descriptions). Two lines: viewer primary, other secondary.
 */
export function formatDualZoneText(
  d: Date,
  viewer: TimeZoneParty,
  other: TimeZoneParty,
  locale: string = DEFAULT_LOCALE,
  now: Date = new Date(),
): string {
  const dz = getDualZoneTime(d, viewer, other, locale, now);
  // Same table treatment as the day labels above, and for the same reason: the
  // two-branch ternary here sent an English "Your time" to every French
  // recipient of a booking email.
  const owner = OWNER_LABELS[locale.slice(0, 2).toLowerCase()] ?? OWNER_LABELS.en;
  const yourTime = owner.yours;
  const otherLabel = owner.theirs(dz.other.label);
  const primary = `${dz.viewer.dateLabel}, ${dz.viewer.timeLabel} (${yourTime})`;
  const secondary = `${otherLabel}: ${dz.other.dateLabel}, ${dz.other.timeLabel} (${dz.other.tzDisplay})`;
  return `${primary}\n${secondary}`;
}
