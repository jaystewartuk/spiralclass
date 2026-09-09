import type { Prisma } from "@prisma/client";
import type { AppLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { INBOX_VISIBLE_TEMPLATE_NAMES, renderInboxItem, type InboxItem } from "./inbox";
import {
  packageIdFromNotificationMetadata,
  packageRefFromBookingCache,
  preloadBookings,
  preloadPackages,
  preloadPayments,
  type LoadedBooking,
} from "./dispatcher";

// Batch-load the bookings referenced by a page of inbox rows into one cache,
// so per-row rendering doesn't fire a booking query each (the inbox N+1). Rows
// without a bookingId contribute nothing.
function preloadPageBookings(rows: Array<{ teacherId: string; bookingId: string | null }>) {
  return preloadBookings(
    prisma,
    rows
      .filter((r): r is { teacherId: string; bookingId: string } => r.bookingId !== null)
      .map((r) => ({ teacherId: r.teacherId, bookingId: r.bookingId })),
  );
}

// Batch-load the payments referenced by a page of inbox rows (payment_received,
// payment_pending_teacher, wise_*, payment_failed_student, refund_issued_*) —
// mirrors preloadPageBookings for the payment-keyed templates.
function preloadPagePayments(rows: Array<{ teacherId: string; paymentId: string | null }>) {
  return preloadPayments(
    prisma,
    rows
      .filter((r): r is { teacherId: string; paymentId: string } => r.paymentId !== null)
      .map((r) => ({ teacherId: r.teacherId, paymentId: r.paymentId })),
  );
}

// Batch-load the packages referenced by a page of inbox rows: either directly
// via metadata (package_expiry_nudge, package_consumed_student/teacher), or
// indirectly via an already-preloaded booking (booking_confirmation's
// classesRemaining) — mirrors preloadPageBookings for the package-keyed
// templates.
function preloadPagePackages(
  rows: Array<{
    teacherId: string;
    bookingId: string | null;
    templateName: string;
    metadata: Prisma.JsonValue | null;
  }>,
  bookingCache: Map<string, LoadedBooking | null>,
) {
  const refs: Array<{ teacherId: string; packageId: string }> = [];
  for (const row of rows) {
    const metaPackageId = packageIdFromNotificationMetadata(row.templateName, row.metadata);
    if (metaPackageId) refs.push({ teacherId: row.teacherId, packageId: metaPackageId });
    if (row.templateName === "booking_confirmation" && row.bookingId) {
      const ref = packageRefFromBookingCache(row.teacherId, row.bookingId, bookingCache);
      if (ref) refs.push(ref);
    }
  }
  return preloadPackages(prisma, refs);
}

// Teacher-facing inbox data access. Every query is scoped to the calling
// teacher: rows where `teacherId` is the teacher AND `recipientType` is
// 'teacher' (so a teacher only ever sees notifications addressed to them, not
// the student-recipient rows that share the same teacherId). This is the
// teacher-side inbox — the surface for the missed-email problem (e.g. a Wise
// payment a student marked sent that's still waiting to be activated).

const INBOX_PAGE_SIZE = 50;

// How many inbox rows are rendered concurrently.
//
// renderInboxItem is batched against preloaded booking/payment/package caches,
// but a cache only covers the ids reachable from the notification's own
// columns — several templates resolve a booking out of `metadata` instead and
// still issue their own `prisma.booking.findFirst`. A bare
// `Promise.all(pageRows.map(...))` therefore opens up to INBOX_PAGE_SIZE
// queries at once against a client pool of 10 (`connection_limit=10`,
// `pool_timeout=10` — see lib/prisma.ts), and the tail of the page times out:
// "Timed out fetching a new connection from the connection pool", thrown at
// `Promise.all (index 25)` on GET /notifications (Sentry AGENDAPROFE-1W and
// siblings). It is a self-inflicted stampede, not load — it reproduced 22
// minutes after a cold boot with one user on the page.
//
// Capping below the pool size leaves connections for the rest of the request
// (and for /api/health's own SELECT 1, whose starvation is the same bug one
// layer down — SPIRALCLASS-21). Batches are awaited in order and results
// concatenated, so item order still matches `pageRows`.
const INBOX_RENDER_CONCURRENCY = 5;

// Map `rows` through `render` in bounded-concurrency batches, preserving order.
// Same shape as the batching in cancellation/blocked-date-collision.ts and
// calendar/google/sync.ts.
async function renderInBatches<Row, Item>(
  rows: Row[],
  render: (row: Row) => Promise<Item>,
): Promise<Item[]> {
  const out: Item[] = [];
  for (let i = 0; i < rows.length; i += INBOX_RENDER_CONCURRENCY) {
    const batch = rows.slice(i, i + INBOX_RENDER_CONCURRENCY);
    out.push(...(await Promise.all(batch.map(render))));
  }
  return out;
}

// Inbox retention window.
//
// The inbox read-model shows the last INBOX_RETENTION_DAYS of notifications.
// Older rows stay in the table untouched — a Notification row is the delivery
// record (`status`/`error`/`providerMessageId`/`sentAt`), read back by
// poll-push-receipts, redispatch-queued, and support lookups ("was her receipt
// ever sent?"). So this is a *visibility* window, deliberately NOT a purge:
// nothing is deleted and no audit trail is lost.
//
// It exists because the list had no floor at all. Every notification a
// recipient had ever received stayed in the inbox forever, and at three
// pre-class reminders per class per side that compounds fast — the practical
// effect was an inbox nobody could ever get to the bottom of. A rolling window
// keeps it short without asking users to do housekeeping, and without adding a
// destructive user-facing "clear" action over the delivery record.
export const INBOX_RETENTION_DAYS = 90;

// Start of the retention window: a rolling INBOX_RETENTION_DAYS × 24h before
// `now`, in absolute time. Deliberately not calendar-day arithmetic in a
// recipient's zone — the boundary is a rough cutoff on a 90-day scale, so an
// hour of DST drift is immaterial, and an absolute duration avoids having to
// pick *whose* zone a multi-teacher student's inbox would be trimmed in.
export function inboxWindowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - INBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

// Cursor-based pagination for the inbox lists. The cursor is the `id` of the
// last row returned on the previous page; rows are always ordered
// `createdAt desc, id desc`, so seeking past a cursor is a `cursor`+`skip:1`
// Prisma query. We fetch one extra row (PAGE_SIZE + 1): if it comes back the
// list has more, and we slice it off and hand its predecessor's id back as
// `nextCursor`. `nextCursor === null` means the caller has reached the end.
export type InboxPage<T> = { items: T[]; nextCursor: string | null };

export type InboxListOpts = {
  // Page size; defaults to INBOX_PAGE_SIZE.
  take?: number;
  // Opaque cursor from a previous page's `nextCursor` (a notification id).
  cursor?: string | null;
  // Narrow to rows the recipient has not opened yet. Applied in the WHERE
  // clause rather than by filtering the rendered page, so an "unread" view
  // returns a full page of unread rows instead of however many of the newest
  // fifty happened to be unread — and so it pages the same way the full list
  // does. The cursor stays comparable across both views: it is an id, and the
  // ordering (`createdAt desc, id desc`) does not depend on read state.
  unreadOnly?: boolean;
};

// How many notifications a teacher has not yet opened. Drives the nav bell
// badge. Filtered to inbox-visible templates AND the retention window so it
// agrees with the list — a badge counting rows the list won't render is a
// permanently stuck count the teacher has no way to clear.
export async function getTeacherInboxUnreadCount(teacherId: string): Promise<number> {
  return prisma.notification.count({
    where: {
      teacherId,
      recipientType: "teacher",
      readAt: null,
      templateName: { in: INBOX_VISIBLE_TEMPLATE_NAMES },
      createdAt: { gte: inboxWindowStart() },
    },
  });
}

// The teacher's most recent notifications, newest first, rendered for display.
// Includes delivered, failed, and never-sent rows alike — the whole point of
// the inbox is to be the durable record regardless of what the email/WhatsApp/
// push channel did.
export async function listTeacherInbox(
  teacherId: string,
  locale: AppLocale,
  opts?: { take?: number; unreadOnly?: boolean },
): Promise<InboxItem[]> {
  const { items } = await listTeacherInboxPage(teacherId, locale, opts);
  return items;
}

// Paginated variant: same rows as listTeacherInbox, but returns a `nextCursor`
// (the id to pass back to fetch the next, older page) so a "load more" caller
// can walk past the first INBOX_PAGE_SIZE rows. Existing array callers use the
// wrapper above and never see the cursor.
export async function listTeacherInboxPage(
  teacherId: string,
  locale: AppLocale,
  opts?: InboxListOpts,
): Promise<InboxPage<InboxItem>> {
  const teacher = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: { name: true, timezone: true },
  });
  if (!teacher) return { items: [], nextCursor: null };

  const take = opts?.take ?? INBOX_PAGE_SIZE;
  const rows = await prisma.notification.findMany({
    where: {
      teacherId,
      recipientType: "teacher",
      templateName: { in: INBOX_VISIBLE_TEMPLATE_NAMES },
      // Retention window. Paging older than this returns nothing, so a "load
      // more" walk terminates at the window edge with nextCursor === null
      // rather than running off the end of the teacher's whole history.
      createdAt: { gte: inboxWindowStart() },
      ...(opts?.unreadOnly ? { readAt: null } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // Fetch one extra row to detect whether an older page exists.
    take: take + 1,
    ...(opts?.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      teacherId: true,
      templateName: true,
      bookingId: true,
      paymentId: true,
      metadata: true,
      readAt: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > take;
  const pageRows = hasMore ? rows.slice(0, take) : rows;
  const nextCursor = hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null;

  const bookingCache = await preloadPageBookings(pageRows);
  const [paymentCache, packageCache] = await Promise.all([
    preloadPagePayments(pageRows),
    preloadPagePackages(pageRows, bookingCache),
  ]);
  const items = await renderInBatches(pageRows, (row) =>
    renderInboxItem(prisma, row, {
      teacherName: teacher.name,
      // Teacher-only inbox — the viewer IS the teacher.
      recipientTimezone: teacher.timezone,
      teacherTimezone: teacher.timezone,
      locale,
      bookingCache,
      paymentCache,
      packageCache,
    }),
  );
  return { items: items.filter((item): item is InboxItem => item !== null), nextCursor };
}

// Mark one notification read. Scoped by teacherId + recipientType so a teacher
// can only ever touch their own rows. Returns the number of rows updated (0 if
// the id doesn't belong to this teacher or was already read).
export async function markTeacherNotificationRead(
  teacherId: string,
  notificationId: string,
  now: Date = new Date(),
): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: {
      id: notificationId,
      teacherId,
      recipientType: "teacher",
      readAt: null,
    },
    data: { readAt: now },
  });
  return result.count;
}

// Mark every unread inbox notification read. Used by the "mark all as read"
// action. Returns how many rows were flipped.
//
// Deliberately NOT limited to the retention window, unlike the list/count
// above. Windowing the *reads* would leave a row that ages out while still
// unread stuck at `readAt: null` forever; sweeping everything costs one
// unbounded-but-indexed UPDATE and leaves no lingering unread state behind the
// window edge. Same reasoning for markTeacherNotificationRead: an id-scoped
// mark on a row that just aged out should succeed, not silently no-op.
export async function markAllTeacherNotificationsRead(
  teacherId: string,
  now: Date = new Date(),
): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: {
      teacherId,
      recipientType: "teacher",
      readAt: null,
      templateName: { in: INBOX_VISIBLE_TEMPLATE_NAMES },
    },
    data: { readAt: now },
  });
  return result.count;
}
