/**
 * The decisions the teacher's payments ledger makes before it renders
 * anything: which of the four views is being asked for, what the search box
 * actually searched for, which calendar month a payment belongs to, and how
 * long a transfer has been sitting on HER to confirm.
 *
 * Kept pure and out of the page so each of them is unit-testable. The page
 * owns the queries and the markup; none of that is decided here. Mirrors
 * `classes-list.ts`, which does the same job for the class roster.
 */

import type { PaymentStatus } from "@prisma/client";
import { toYMD } from "@/lib/tz";

/**
 * The four views of the ledger.
 *
 * They are the four questions a teacher opens this page with, in the order she
 * asks them: what is everything, what is still owed to me, what landed, what
 * did I give back.
 *
 * `failed` is deliberately NOT a view. A failed payment is a card Stripe
 * declined or a transfer she told us never arrived — it is not money, it is
 * not a job, and there is nothing to do with a list of them. They stay visible
 * under `all` (and findable by search) rather than getting a tab that reads as
 * a queue when it is a footnote.
 */
export const PAYMENTS_SCOPES = ["all", "pending", "paid", "refunded"] as const;
export type PaymentsScope = (typeof PAYMENTS_SCOPES)[number];

export const DEFAULT_PAYMENTS_SCOPE: PaymentsScope = "all";

/**
 * The payment statuses each view shows, or `null` for "every status".
 *
 * Returned as data rather than as a Prisma `where` so the mapping is testable
 * without a client, and so the page composes it with its own tenancy filter
 * instead of this module knowing anything about teachers. The value type is
 * Prisma's own enum (a TYPE-only import, erased at runtime) so a view cannot
 * be pointed at a status that does not exist — a plain `string[]` would have
 * let `underpaid`, which this schema has never had, sit here unnoticed.
 */
export const PAYMENTS_SCOPE_STATUSES: Record<PaymentsScope, readonly PaymentStatus[] | null> = {
  all: null,
  pending: ["pending"],
  paid: ["paid"],
  refunded: ["refunded"],
};

/**
 * A `?show=` value from the URL, narrowed. Anything unrecognised falls back to
 * the default rather than 404ing: this parameter is a view preference, and a
 * stale bookmark or a hand-edited link should still show her the money.
 */
export function resolvePaymentsScope(raw: string | string[] | undefined): PaymentsScope {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (PAYMENTS_SCOPES as readonly string[]).includes(value ?? "")
    ? (value as PaymentsScope)
    : DEFAULT_PAYMENTS_SCOPE;
}

/**
 * The longest search term the page will act on. Not a security boundary —
 * Prisma parameterises the value — but an unbounded string in a `contains`
 * filter is an unbounded scan, and nothing this searches (a name, an email, a
 * payment reference) is anywhere near this long.
 */
export const PAYMENT_SEARCH_MAX_LENGTH = 60;

/**
 * A `?q=` value from the URL, normalised. Returns an empty string for "no
 * search", so the caller has one falsy check rather than an
 * undefined/empty distinction that means nothing to it.
 */
export function normalizePaymentSearch(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? "").trim().slice(0, PAYMENT_SEARCH_MAX_LENGTH);
}

/** How many payments one page of the ledger shows. */
export const PAYMENTS_PAGE_SIZE = 25;

/**
 * "Which payments am I looking at", as a query string — `""` for the canonical
 * unfiltered first page.
 *
 * Shared by the page's own links and by the CSV export href, which points at a
 * different path but has to describe the SAME selection: the file a teacher
 * downloads should be the rows she was looking at, and two hand-built query
 * strings are two chances for it not to be.
 *
 * Page 1 is left out — it is the default, and a `?page=1` in a shared link is
 * noise that also splits the browser's history entry for the same view.
 */
export function paymentsQuery(scope: PaymentsScope, search = "", page = 1): string {
  const params = new URLSearchParams();
  if (scope !== DEFAULT_PAYMENTS_SCOPE) params.set("show", scope);
  if (search) params.set("q", search);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** The canonical URL for a view of the ledger, so no call site builds one by hand. */
export function paymentsHref(scope: PaymentsScope, search = "", page = 1): string {
  return `/payments${paymentsQuery(scope, search, page)}`;
}

/**
 * Where a still-pending transfer sits, from the TEACHER's side.
 *
 * The distinction is the whole reason the page has a "needs you" section at
 * all. A pending payment where the student has not yet said they sent the
 * money is not a job — she cannot confirm a transfer that has not been made,
 * and putting it in front of her trains her to ignore the section. One the
 * student HAS marked sent is the only state where the ball is in her court:
 * check the account, confirm, and the package activates.
 *
 * `overdue` is the same state gone stale. The threshold matches the reminder
 * cron's default (`sendTransferConfirmReminders`, 24h) on purpose — the screen
 * and the notification that nags about the same payment must not disagree
 * about when it started being late.
 */
export const TRANSFER_OVERDUE_HOURS = 24;

export type TransferState =
  | { state: "awaiting_student" }
  | { state: "ready"; hoursWaiting: number }
  | { state: "overdue"; hoursWaiting: number };

export function transferState(
  studentMarkedSentAt: Date | null | undefined,
  now: Date,
): TransferState {
  if (!studentMarkedSentAt) return { state: "awaiting_student" };
  // FLOORED, and clamped at zero. A clock skew that puts the mark-sent stamp a
  // few seconds in the future must not render "-1 hours ago"; and a payment
  // marked sent 23h59m ago is not yet the thing the reminder cron calls stale.
  const hoursWaiting = Math.max(
    0,
    Math.floor((now.getTime() - studentMarkedSentAt.getTime()) / 3_600_000),
  );
  return hoursWaiting >= TRANSFER_OVERDUE_HOURS
    ? { state: "overdue", hoursWaiting }
    : { state: "ready", hoursWaiting };
}

/**
 * How long a transfer has been waiting, as a catalog key plus its variables.
 *
 * Returned rather than rendered so this stays free of the i18n runtime and the
 * caller keeps the one `t` it already has — the same contract `proximityLabel`
 * uses on the class list. Under an hour reads "just now" rather than "0 hours
 * ago", which is both wrong-looking and less true than the vaguer phrasing.
 *
 * The variable is named `count` because that is the name `createT` looks for
 * when it picks a CLDR plural variant: "1 hour" and "2 hours" are one key with
 * an `_one` sibling, not a hand-rolled `n === 1` at the call site.
 */
export function transferWaitLabel(state: TransferState): {
  key: "web.payments.wait.justNow" | "web.payments.wait.hours" | "web.payments.wait.days";
  vars?: { count: number };
} | null {
  if (state.state === "awaiting_student") return null;
  if (state.hoursWaiting < 1) return { key: "web.payments.wait.justNow" };
  if (state.hoursWaiting < TRANSFER_OVERDUE_HOURS)
    return { key: "web.payments.wait.hours", vars: { count: state.hoursWaiting } };
  return { key: "web.payments.wait.days", vars: { count: Math.floor(state.hoursWaiting / 24) } };
}

/** The shape month-grouping needs. Anything wider is the caller's business. */
export type LedgerEntry = {
  createdAt: Date;
  status: string;
  amountMinorUnits: number;
  currency: string;
};

export type MonthTotal = { currency: string; cents: number };

export type LedgerMonth<T> = {
  /** `YYYY-MM` in the teacher's zone — the stable key, and what the heading derives from. */
  key: string;
  /**
   * Midday UTC on the 1st of that month, safe to hand straight to `Intl` for a
   * "September 2026" heading. MIDDAY, not midnight: a heading formatted in a
   * zone behind UTC would otherwise land on the last day of the previous month
   * and label August's rows "August" while they are filed under September.
   */
  date: Date;
  entries: T[];
};

/** `YYYY-MM` for an instant, on the teacher's calendar rather than UTC's. */
export function monthKey(at: Date, timeZone: string): string {
  return toYMD(at, timeZone).slice(0, 7);
}

/**
 * The month after a `YYYY-MM` key, rolling the year over at December.
 *
 * Exists so the page can turn "the months this page of rows touches" into a
 * half-open date range without doing string arithmetic on a month number at
 * the call site, which is where an off-by-one silently drops December.
 */
export function nextMonthKey(key: string): string {
  const [year, month] = key.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1, 12));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Group a ledger page into calendar months, newest first, preserving the order
 * the caller sorted in.
 *
 * The month boundary is the TEACHER's, not UTC: a payment taken at 7pm on the
 * 31st in Mexico City is stamped the 1st in UTC, and filing it under next
 * month would put it on the wrong side of the line she does her books by.
 */
export function groupPaymentsByMonth<T extends LedgerEntry>(
  entries: readonly T[],
  timeZone: string,
): LedgerMonth<T>[] {
  const months: LedgerMonth<T>[] = [];
  const byKey = new Map<string, LedgerMonth<T>>();

  for (const entry of entries) {
    const key = monthKey(entry.createdAt, timeZone);
    let month = byKey.get(key);
    if (!month) {
      const [year, monthNumber] = key.split("-").map(Number);
      month = { key, date: new Date(Date.UTC(year, monthNumber - 1, 1, 12)), entries: [] };
      byKey.set(key, month);
      months.push(month);
    }
    month.entries.push(entry);
  }

  return months;
}

/**
 * What actually LANDED in each month, per currency.
 *
 * Deliberately NOT derived from the rows on screen. A page holds 25 payments
 * and a month rarely divides evenly into that, so summing the visible rows
 * would print "August — $3,250 received" on page 1 and a different August
 * total on page 2, each of them a slice presented as a month. The caller feeds
 * this the month's payments in full, and the heading gets an answer that does
 * not change when you turn the page.
 *
 * Only `paid` rows count: pending money may never arrive and refunded money
 * left again, so including either would give her a figure she cannot reconcile
 * against her account. Per currency because a teacher who changed her pricing
 * currency has months that legitimately hold two, and adding minor units
 * across currencies produces a meaningless number (D-64).
 */
export function receivedByMonth(
  entries: readonly LedgerEntry[],
  timeZone: string,
): Map<string, MonthTotal[]> {
  const byMonth = new Map<string, MonthTotal[]>();
  for (const entry of entries) {
    if (entry.status !== "paid") continue;
    const key = monthKey(entry.createdAt, timeZone);
    let totals = byMonth.get(key);
    if (!totals) byMonth.set(key, (totals = []));
    const total = totals.find((tot) => tot.currency === entry.currency);
    if (total) total.cents += entry.amountMinorUnits;
    else totals.push({ currency: entry.currency, cents: entry.amountMinorUnits });
  }
  return byMonth;
}
