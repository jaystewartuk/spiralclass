/**
 * The decisions the notifications inbox makes before it renders anything.
 *
 * Kept pure and out of the page — which view is being asked for, what kind of
 * event a row is, and which calendar day it belongs to — so all three are unit
 * testable without a database, a request or a React tree. The page owns the
 * queries and the markup; none of that is decided here.
 *
 * Same split (and the same reasoning) as `lib/classes-list.ts`, which the
 * teacher class list uses for exactly this.
 */
import { shiftDay } from "@/lib/calendar-grid";
import { formatZonedDayHeader } from "@/lib/date-display";
import type { AppLocale, TFunction } from "@/lib/i18n-translate";
import { toYMD } from "@/lib/tz";
import type { TemplateName } from "./templates";

// ---------------------------------------------------------------------------
// The two views of the inbox
// ---------------------------------------------------------------------------

/**
 * LINKS, NOT A TAB WIDGET — see `ClassesToolbar`, which made the same call for
 * the same reason. Each value is a different server-rendered list at its own
 * URL, so it is navigation: deep-linkable, back-buttonable, and working with
 * JavaScript off.
 */
export const INBOX_FILTERS = ["all", "unread"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

export const DEFAULT_INBOX_FILTER: InboxFilter = "all";

/**
 * A `?show=` value from the URL, narrowed. Anything unrecognised falls back to
 * the default rather than 404ing: this parameter is a view preference, and a
 * stale or hand-edited link should still show the teacher her notifications.
 */
export function resolveInboxFilter(raw: string | string[] | undefined): InboxFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (INBOX_FILTERS as readonly string[]).includes(value ?? "")
    ? (value as InboxFilter)
    : DEFAULT_INBOX_FILTER;
}

/**
 * A `?cursor=` value from the URL, narrowed to something that could plausibly
 * be a notification id.
 *
 * Not a security boundary — every query is scoped to the calling teacher, and
 * a cursor pointing at someone else's row simply returns her own rows from
 * that position — but an unbounded string handed to Prisma's `cursor` is an
 * unbounded value in an index seek, and no cuid is anywhere near this long.
 */
export const INBOX_CURSOR_MAX_LENGTH = 64;

export function resolveInboxCursor(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed.length > INBOX_CURSOR_MAX_LENGTH) return null;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

/** The canonical URL for a view of the inbox, so no call site builds one by hand. */
export function inboxHref(filter: InboxFilter, cursor?: string | null): string {
  const params = new URLSearchParams();
  if (filter !== DEFAULT_INBOX_FILTER) params.set("show", filter);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return query ? `/notifications?${query}` : "/notifications";
}

// ---------------------------------------------------------------------------
// What kind of event a row is
// ---------------------------------------------------------------------------

/**
 * The kind of thing that happened, as far as the reader is concerned.
 *
 * WHY THIS EXISTS. Every row in this list rendered identically — a dot, a
 * title, a body, a time — so a £400 sale and a five-minute class reminder were
 * the same shape on the page, and the only way to tell them apart was to read
 * both in full. That is the specific failure an inbox has to avoid, because an
 * inbox is scanned rather than read.
 *
 * A category is deliberately COARSER than a template: there are forty-nine
 * templates and fourteen categories, because the reader is asking "is this
 * money, a class, or a chore?" and not "which of the six pre-class reminders
 * is this?". The title already says the latter.
 *
 * The map below is exhaustive over `TemplateName` BY TYPE, so adding a
 * template is a compile error until someone decides where it belongs. That is
 * the property worth having: the alternative is a new template silently
 * landing in the generic bucket, which is how a categorised list quietly
 * decays back into an uncategorised one.
 */
export const INBOX_CATEGORIES = [
  "payment",
  "refund",
  "booking",
  "reminder",
  "cancellation",
  "message",
  "homework",
  "material",
  "package",
  "accountReady",
  "accountAction",
  "subscription",
  "growth",
  "insight",
  "general",
] as const;
export type InboxCategory = (typeof INBOX_CATEGORIES)[number];

const CATEGORY_BY_TEMPLATE: Record<TemplateName, InboxCategory> = {
  // Money arriving, or on its way. `payment_pending_teacher` and the two Wise
  // rows are here rather than under `refund` because they are a sale that has
  // happened and is waiting on a confirmation, not a problem.
  payment_received: "payment",
  payment_received_teacher: "payment",
  payment_pending_teacher: "payment",
  payment_marked_sent_teacher: "payment",
  wise_marked_sent_student: "payment",
  wise_confirm_reminder_teacher: "payment",

  // Money going back, or not arriving at all. A lost dispute belongs here for
  // the same reason a refund does: the money has left, and what the reader
  // needs is the fact and the amount, not a sale to celebrate. (Both kinds
  // arrived with #1017, after this map was written.)
  payment_failed_student: "refund",
  refund_issued_student: "refund",
  refund_issued_teacher: "refund",
  dispute_lost_student: "refund",
  dispute_lost_teacher: "refund",

  // A class exists, or moved.
  booking_confirmation: "booking",
  booking_created_teacher: "booking",
  reschedule_confirm: "booking",
  reschedule_confirm_teacher: "booking",

  // A class is about to start.
  reminder_24h: "reminder",
  reminder_1h: "reminder",
  reminder_15m: "reminder",
  reminder_24h_teacher: "reminder",
  reminder_1h_teacher: "reminder",
  reminder_15m_teacher: "reminder",

  // A class is not happening.
  cancel_lt24h: "cancellation",
  cancel_gte24h_with_reschedule: "cancellation",
  cancel_lt24h_teacher: "cancellation",
  cancel_gte24h_teacher: "cancellation",
  teacher_cancel: "cancellation",
  no_show_student: "cancellation",

  chat_message: "message",
  chat_message_teacher: "message",

  homework_submitted_teacher: "homework",
  homework_assigned_student: "homework",
  homework_feedback_available_student: "homework",
  homework_due_soon_student: "homework",
  homework_overdue_student: "homework",

  materials_send: "material",
  library_material_assigned: "material",

  package_expiry_nudge: "package",
  package_consumed_student: "package",
  package_consumed_teacher: "package",

  // Split from the two below on purpose: "you can take card payments now" is
  // good news and "your account is disabled" is a job, and an inbox that gives
  // them the same mark is one the teacher learns to ignore.
  stripe_ready_teacher: "accountReady",
  stripe_requirements_teacher: "accountAction",
  account_disabled_teacher: "accountAction",

  subscription_trial_ending: "subscription",
  subscription_payment_succeeded: "subscription",
  subscription_payment_failed: "subscription",
  subscription_canceled: "subscription",
  subscription_founding_price_locked: "subscription",

  student_acquisition_plan_teacher: "growth",
  facebook_groups_nudge_teacher: "growth",

  lesson_insights_review_teacher: "insight",

  // Never rendered — `INBOX_HIDDEN_TEMPLATES` filters it out before the list
  // sees it — but the map is exhaustive by type, so it needs an answer.
  magic_link: "general",
};

/**
 * The category for a stored `template_name`.
 *
 * Takes a plain string rather than a `TemplateName` because the column is a
 * string and rows written by an older deploy outlive the union. An unknown
 * name falls back to `general` instead of throwing: a notification whose
 * template this build has never heard of should still render as a
 * notification.
 */
export function inboxCategoryFor(templateName: string): InboxCategory {
  return CATEGORY_BY_TEMPLATE[templateName as TemplateName] ?? "general";
}

// ---------------------------------------------------------------------------
// Which day a row belongs to
// ---------------------------------------------------------------------------

export type InboxDayGroup<T> = {
  /** Calendar date in the viewer's zone, `YYYY-MM-DD`. Stable React key. */
  ymd: string;
  label: string;
  /**
   * Which of the two named days this is, if either — so a caller can give
   * today's group more weight than a date six weeks out without re-deriving
   * the comparison from the label string.
   */
  relative: "today" | "yesterday" | null;
  items: T[];
};

/**
 * Group notifications by the calendar day they arrived on, in the TEACHER's
 * zone.
 *
 * Her zone and not the server's, and a calendar day and not a rolling 24
 * hours: "today" is a day on her wall clock, and a DST transition makes one of
 * those 23 or 25 hours long. `shiftDay` rather than `now - 86_400_000` for the
 * same reason — the arithmetic that mislabels "Yesterday" twice a year.
 *
 * Rows arrive newest-first and stay in that order; groups are emitted in first
 * -seen order, so the sequence the query chose is the sequence the page shows.
 */
export function groupInboxByDay<T extends { createdAt: Date }>(
  items: T[],
  tz: string,
  locale: AppLocale,
  now: Date,
  t: TFunction,
): InboxDayGroup<T>[] {
  const todayYmd = toYMD(now, tz);
  const yesterdayYmd = shiftDay(todayYmd, -1);

  const groups: InboxDayGroup<T>[] = [];
  for (const item of items) {
    const ymd = toYMD(item.createdAt, tz);
    let group = groups.find((g) => g.ymd === ymd);
    if (!group) {
      const relative = ymd === todayYmd ? "today" : ymd === yesterdayYmd ? "yesterday" : null;
      const label =
        relative === "today"
          ? t("web.notifications.group.today")
          : relative === "yesterday"
            ? t("web.notifications.group.yesterday")
            : formatZonedDayHeader(item.createdAt, tz, locale);
      group = { ymd, label, relative, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
