// What "limited promotion" actually MEANS for one community.
//
// `promoPolicy` (channels.ts) answers a coarse question — may she promote here
// at all — and it is the load-bearing platform-safety gate. But `limited` was
// the answer for most real communities and it said nothing further: not which
// days the group's rules allow a promo post, not how often, not whether a link
// is tolerated. So the teacher recorded "limited" and then had to remember the
// actual rule herself, which is precisely the memory this product exists to
// replace.
//
// Two kinds of rule, deliberately kept apart:
//
//   * STRUCTURED — weekdays, a minimum gap, and whether links are allowed.
//     These the app UNDERSTANDS: it can tell her today is not a promo day, and
//     it can refuse to mint a tracked link for a community that forbids one.
//     Deterministic, testable, no model involved.
//   * FREE TEXT — everything a group's rules say that no schema will ever
//     capture ("only in the Friday thread", "tag your post [SERVICE]"). This
//     is CONTEXT for generation, never an enforced constraint. Treating a
//     sentence as a guarantee is how a safety gate becomes a liability.
//
// Shared between web and mobile so neither client can enforce a different
// reading of the same row.

import type { Weekday } from "../api";
import type { AppLocale } from "../i18n/locales";
import { allowsInlineLink, type MarketingPlatform, type PromoPolicy } from "./channels";

// `Weekday` (0 = Sunday .. 6 = Saturday) is the wire contract's own type,
// reused rather than redeclared: the availability rules already speak it, and
// two structurally identical aliases with one name is how a re-export
// ambiguity starts.
export type { Weekday };

export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6] as const;

/** Free-text rules the teacher copied out of the community's own pinned post. */
export const PROMO_NOTES_MAX_CHARS = 400;

/** Upper bound on the "one promo every N days" rule. A quarter is already far
 * past any real group rule, and an unbounded number would let a typo lock a
 * community for years with no obvious way back. */
export const PROMO_EVERY_DAYS_MAX = 90;

export type PromotionRules = {
  /** Days promotion is permitted. EMPTY MEANS ANY DAY — not "no days". The
   * empty array is the unconfigured state, and the unconfigured state must
   * never be the one that silently blocks her. */
  weekdays: Weekday[];
  /** At most one promotional post every N days. Null = no frequency rule. */
  everyDays: number | null;
  /** Explicit override of whether a link may appear in the body.
   * Null = fall back to the platform's own placement rule plus the policy. */
  linksAllowed: boolean | null;
  /** The group's rules in her own words. Context for generation only. */
  notes: string | null;
};

export const DEFAULT_PROMOTION_RULES: PromotionRules = {
  weekdays: [],
  everyDays: null,
  linksAllowed: null,
  notes: null,
};

export function isWeekday(value: unknown): value is Weekday {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
}

/** Deduped, sorted, in range. A stored array from a newer deploy, a hand-edited
 * row or a malformed form post all degrade to something sane rather than
 * throwing on a page render. */
export function normalizeWeekdays(value: unknown): Weekday[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<Weekday>();
  for (const raw of value) {
    const n = typeof raw === "string" ? Number(raw) : raw;
    if (isWeekday(n)) seen.add(n);
  }
  // All seven selected is the same statement as none selected ("any day"), and
  // storing it as empty keeps one canonical representation of one meaning.
  if (seen.size === WEEKDAYS.length) return [];
  return [...seen].sort((a, b) => a - b);
}

export function normalizeEveryDays(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const int = Math.trunc(n);
  if (int < 1) return null;
  return Math.min(int, PROMO_EVERY_DAYS_MAX);
}

/**
 * Whether a promotional post may carry a tracked link in its body.
 *
 * The community's explicit answer wins in BOTH directions: a group whose rules
 * say "links in comments only" turns it off even on a platform where links are
 * normal, and a group that explicitly allows them turns it on — but never past
 * the policy gate. A prohibited or unconfirmed community carries no link
 * whatever the override says, because that gate is what stops the product from
 * helping her get removed.
 */
export function communityAllowsLink(input: {
  platform: MarketingPlatform;
  promoPolicy: PromoPolicy;
  rules: PromotionRules;
}): boolean {
  const platformDefault = allowsInlineLink(input.platform, input.promoPolicy);
  if (input.rules.linksAllowed === null) return platformDefault;
  if (input.rules.linksAllowed === false) return false;
  // An explicit "yes" still cannot open a community the policy has closed.
  return input.promoPolicy === "open" || input.promoPolicy === "limited";
}

/** Whether this weekday is one the community's rules permit. */
export function promotionAllowedOnWeekday(rules: PromotionRules, weekday: number): boolean {
  if (rules.weekdays.length === 0) return true;
  return isWeekday(weekday) && rules.weekdays.includes(weekday);
}

/**
 * The next weekday (as an offset in days, 0 = today) on which promotion is
 * permitted. Null when the rules permit no day at all, which normalizeWeekdays
 * makes unreachable but which callers should not have to assume.
 */
export function daysUntilNextPromotionWeekday(rules: PromotionRules, from: number): number | null {
  if (rules.weekdays.length === 0) return 0;
  for (let offset = 0; offset < 7; offset++) {
    if (rules.weekdays.includes(((((from + offset) % 7) + 7) % 7) as Weekday)) return offset;
  }
  return null;
}

export type PromotionWindow =
  | { allowed: true }
  /** Today is not one of the community's promotion days. `inDays` is how many
   * days until the next one (never 0 here); null only if no day is permitted
   * at all, which normalizeWeekdays makes unreachable. */
  | { allowed: false; reason: "weekday"; inDays: number | null }
  /** She promoted here too recently. */
  | { allowed: false; reason: "frequency"; nextAllowedAt: Date };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * May she post a promotional message here right now?
 *
 * `weekday` is passed IN rather than read off `now`, and that is the whole
 * timezone story: these are her community's rules about her own posting, so the
 * day has to be HER day. A server deriving it from a UTC Date would tell a
 * teacher in Mexico that Monday's window closed on Sunday evening. Callers pass
 * `weekdayInZone(now, teacher.timezone)`.
 *
 * `lastPromotedAt` is the last promotional activity she marked done in this
 * community; null means she never has, so the frequency rule cannot bite.
 *
 * This is ADVISORY, never a block: the app tells her, it does not stop her. She
 * is the one who read the group's rules, and a mistyped rule must not be able
 * to lock her out of her own community.
 */
export function promotionWindow(input: {
  rules: PromotionRules;
  /** 0 = Sunday .. 6 = Saturday, in the teacher's own timezone. */
  weekday: number;
  now: Date;
  lastPromotedAt?: Date | null;
}): PromotionWindow {
  const { rules, now } = input;

  if (rules.everyDays !== null && input.lastPromotedAt) {
    const nextAt = new Date(input.lastPromotedAt.getTime() + rules.everyDays * DAY_MS);
    if (nextAt.getTime() > now.getTime()) {
      return { allowed: false, reason: "frequency", nextAllowedAt: nextAt };
    }
  }

  if (!promotionAllowedOnWeekday(rules, input.weekday)) {
    return {
      allowed: false,
      reason: "weekday",
      inDays: daysUntilNextPromotionWeekday(rules, input.weekday),
    };
  }

  return { allowed: true };
}

/** True when the teacher has actually configured something beyond the default —
 * what the UI uses to decide between "Limited" and "Limited · the specifics". */
export function hasPromotionRules(rules: PromotionRules): boolean {
  return (
    rules.weekdays.length > 0 ||
    rules.everyDays !== null ||
    rules.linksAllowed !== null ||
    (rules.notes !== null && rules.notes.trim().length > 0)
  );
}

/** Localised weekday names, short form, in the app's Sunday-first order.
 * Derived from Intl rather than the string catalog: seven names per locale is
 * exactly the kind of thing the platform already knows, and adding a locale
 * should not mean adding day names. */
export function weekdayLabels(locale: AppLocale, style: "short" | "long" = "short"): string[] {
  // `timeZone: "UTC"` is load-bearing, not tidiness. The anchor dates below are
  // UTC midnights and Intl formats in the HOST zone by default, so west of
  // Greenwich every label slid back a day: a machine in Mexico City rendered
  // Sunday's column as "Saturday". It was invisible on the servers (UTC) and on
  // CI (UTC), and showed up only on the operator's own laptop.
  const fmt = new Intl.DateTimeFormat(locale, { weekday: style, timeZone: "UTC" });
  // 2024-01-07 was a Sunday; adding the index walks the week in our order.
  return WEEKDAYS.map((d) => fmt.format(new Date(Date.UTC(2024, 0, 7 + d))));
}

/**
 * The structured rules as one short line, for a card the teacher scans.
 * Free-text notes are deliberately NOT folded in: they are hers to read in
 * full, not to be truncated into a chip.
 */
export function describePromotionRules(rules: PromotionRules, locale: AppLocale): string[] {
  const out: string[] = [];
  if (rules.weekdays.length > 0) {
    const labels = weekdayLabels(locale);
    out.push(rules.weekdays.map((d) => labels[d]).join(", "));
  }
  if (rules.everyDays !== null) {
    out.push(
      rules.everyDays === 1
        ? EVERY_DAY_LABEL[locale]
        : interpolateEveryDays(EVERY_N_DAYS_LABEL[locale], rules.everyDays),
    );
  }
  if (rules.linksAllowed === false) out.push(NO_LINKS_LABEL[locale]);
  if (rules.linksAllowed === true) out.push(LINKS_OK_LABEL[locale]);
  return out;
}

// Four fragments, kept here rather than in the string catalog because they are
// produced by this pure function and consumed by both clients, and a catalog
// lookup would make `describePromotionRules` need a `t` it otherwise doesn't.
const EVERY_DAY_LABEL: Record<AppLocale, string> = {
  "es-MX": "Una vez al día",
  en: "Once a day",
  fr: "Une fois par jour",
};

const EVERY_N_DAYS_LABEL: Record<AppLocale, string> = {
  "es-MX": "Una vez cada {n} días",
  en: "Once every {n} days",
  fr: "Une fois tous les {n} jours",
};

const NO_LINKS_LABEL: Record<AppLocale, string> = {
  "es-MX": "Sin enlaces",
  en: "No links",
  fr: "Sans liens",
};

const LINKS_OK_LABEL: Record<AppLocale, string> = {
  "es-MX": "Enlaces permitidos",
  en: "Links allowed",
  fr: "Liens autorisés",
};

function interpolateEveryDays(template: string, n: number): string {
  return template.replace("{n}", String(n));
}
