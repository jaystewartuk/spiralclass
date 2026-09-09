import type { LeadStatus } from "./status";

/**
 * The decisions the leads screen makes before it renders anything.
 *
 * Kept pure and out of the page for the same reason `classes-list.ts` is:
 * which view is being asked for, what the search box actually searched for,
 * and how long someone has been waiting are all testable without a database
 * or a React tree. The page owns the queries and the markup; none of that is
 * decided here.
 */

/**
 * The three views of the enquiry list.
 *
 * `open` is deliberately BOTH `new` and `contacted` rather than one tab each.
 * They are two halves of one working set — she has to look at both to know
 * what is outstanding — and splitting them would put the smaller, more urgent
 * half behind a click. The distinction still exists inside the view, as two
 * headed groups, which is where it belongs: it changes what she does with a
 * lead, not which list it is in.
 */
export const LEAD_SCOPES = ["open", "converted", "archived"] as const;
export type LeadScope = (typeof LEAD_SCOPES)[number];

export const DEFAULT_LEAD_SCOPE: LeadScope = "open";

/** Which lifecycle states each view contains. One source for the query filter
 * and the tab counts, so a view can never show a different set than it counts. */
export const LEAD_SCOPE_STATUSES: Record<LeadScope, readonly LeadStatus[]> = {
  open: ["new", "contacted"],
  converted: ["converted"],
  archived: ["archived"],
};

/**
 * A `?show=` value from the URL, narrowed. Anything unrecognised falls back to
 * the default rather than 404ing: this parameter is a view preference, and a
 * stale or hand-edited link should still show her her leads.
 */
export function resolveLeadScope(raw: string | string[] | undefined): LeadScope {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (LEAD_SCOPES as readonly string[]).includes(value ?? "")
    ? (value as LeadScope)
    : DEFAULT_LEAD_SCOPE;
}

/**
 * The longest search term the page will act on. Not a security boundary —
 * Prisma parameterises the value — but an unbounded string in a `contains`
 * filter is an unbounded scan, and no name or address is anywhere near this
 * long.
 */
export const LEAD_SEARCH_MAX_LENGTH = 60;

/**
 * A `?q=` value from the URL, normalised. Returns an empty string for "no
 * search", so the caller has one falsy check rather than an undefined/empty
 * distinction that means nothing to it.
 */
export function normalizeLeadSearch(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? "").trim().slice(0, LEAD_SEARCH_MAX_LENGTH);
}

/** The canonical URL for a view of the list, so no call site builds one by hand. */
export function leadsHref(scope: LeadScope, search = ""): string {
  const params = new URLSearchParams();
  if (scope !== DEFAULT_LEAD_SCOPE) params.set("show", scope);
  if (search) params.set("q", search);
  const query = params.toString();
  return query ? `/dashboard/leads?${query}` : "/dashboard/leads";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago something happened, as a unit and a whole number.
 *
 * Returned rather than formatted so this module stays free of the i18n
 * runtime and the caller keeps the one `t` it already has — the same
 * arrangement as `proximityLabel` in `classes-list.ts`.
 *
 * FLOORED at every step, and clamped at zero. Flooring means "3 days ago"
 * never overstates how long ago something was; the clamp means a row whose
 * `createdAt` is a few seconds in the future — a clock skew between the app
 * server and Postgres is enough — reads "Just now" rather than "-1 minutes
 * ago".
 */
export type Elapsed = {
  unit: "now" | "minutes" | "hours" | "days";
  count: number;
};

export function elapsedSince(from: Date, now: Date): Elapsed {
  const ms = Math.max(0, now.getTime() - from.getTime());
  if (ms < MINUTE) return { unit: "now", count: 0 };
  if (ms < HOUR) return { unit: "minutes", count: Math.floor(ms / MINUTE) };
  if (ms < DAY) return { unit: "hours", count: Math.floor(ms / HOUR) };
  return { unit: "days", count: Math.floor(ms / DAY) };
}

/**
 * The age past which a relative timestamp stops helping.
 *
 * "3 days ago" is a fact anyone can act on; "127 days ago" is arithmetic
 * dressed as a sentence, and the reader has to do the subtraction anyway to
 * find out which month it was. Past a week the row prints the date instead.
 */
export const RELATIVE_MAX_DAYS = 7;

/** Hours after which an unanswered enquiry is late, then badly late. A day is
 * the point at which a reply stops feeling prompt to the person waiting; three
 * is the point at which they have almost certainly written to someone else. */
export const REPLY_DUE_HOURS = 24;
export const REPLY_OVERDUE_HOURS = 72;

/**
 * How overdue a reply is — the one thing on this screen that is genuinely
 * urgent, and the reason the list is not simply sorted oldest-first.
 *
 * Sorting the queue by age would put a week-old enquiry above one that landed
 * five minutes ago, and the fresh one is the one most likely to still convert.
 * So the order stays newest-first, matching every other list in the app, and
 * the ageing is carried by a badge that gets louder instead. Nothing moves
 * under her; the stale rows just stop being quiet.
 *
 * Only `new` leads have this. Once she has replied, the ball is in the other
 * court and an escalating badge would be nagging her about someone else's
 * silence.
 */
export type ReplyUrgency = "none" | "due" | "overdue";

export function replyUrgency(status: LeadStatus, createdAt: Date, now: Date): ReplyUrgency {
  if (status !== "new") return "none";
  const hours = Math.max(0, now.getTime() - createdAt.getTime()) / HOUR;
  if (hours >= REPLY_OVERDUE_HOURS) return "overdue";
  if (hours >= REPLY_DUE_HOURS) return "due";
  return "none";
}

/**
 * The smallest number of leads a conversion percentage is printed for.
 *
 * One lead out of two converted is "50%", and it is not: it is one lead. A
 * percentage on a handful of rows reads as a measurement while being noise,
 * and this screen is where a teacher decides whether her booking page works.
 */
export const CONVERSION_RATE_MIN_LEADS = 5;

/** Whole-percent conversion, or null when there are too few leads to mean
 * anything. Rounded rather than truncated — this is a summary, not a countdown. */
export function conversionRate(converted: number, total: number): number | null {
  if (total < CONVERSION_RATE_MIN_LEADS || total <= 0) return null;
  return Math.round((converted / total) * 100);
}

/**
 * A `wa.me` deep link for an E.164 number.
 *
 * WhatsApp wants digits only — no `+`, no spaces — and silently opens a
 * "number not on WhatsApp" screen for anything else, which looks like the
 * contact being wrong rather than the link being wrong.
 */
export function whatsappHref(phoneE164: string): string {
  return `https://wa.me/${phoneE164.replace(/\D/g, "")}`;
}

/**
 * A `mailto:` with a subject already filled in.
 *
 * The address is percent-encoded because RFC 6068 says the addr-spec in a
 * mailto URI is, and an unencoded `@` before a `?subject=` is the one case
 * where a client can misparse where the address ends.
 */
export function mailtoHref(email: string, subject: string): string {
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}`;
}
