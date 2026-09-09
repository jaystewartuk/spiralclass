import type { Prisma, PrismaClient } from "@prisma/client";

import type { AppLocale } from "@/lib/i18n";
import { localeToLanguageCode, TEMPLATE_NAMES, type TemplateName } from "./templates";
import { renderPush } from "./push";
import { webPathForDeepLink } from "./web-deep-links";
import {
  buildVariables,
  type LoadedBooking,
  type LoadedPackage,
  type LoadedPayment,
} from "./dispatcher";

// Shared (teacherId, bookingId/paymentId/packageId) → row maps passed across a
// page of inbox rows so booking/payment/package lookups each batch into one
// query. Built by preloadBookings/preloadPayments/preloadPackages.
type BookingCache = Map<string, LoadedBooking | null>;
type PaymentCache = Map<string, LoadedPayment | null>;
type PackageCache = Map<string, LoadedPackage | null>;

// In-app notifications inbox.
//
// The inbox is a *read-model* over the rows the dispatcher already writes to
// the `notifications` table. Every notifiable event lands as one row the
// moment it happens (see enqueue.ts); the `channel` column only records how it
// was later delivered externally. So the inbox needs no new write path — even
// a notification whose email was missed (or never sent) is present as a row.
//
// Rendering reuses the dispatcher's `buildVariables` + the push renderer so
// the title/body/link a teacher sees in the inbox can never drift from what
// they were actually sent. `renderPush` already returns short, glanceable copy
// in both locales plus the same relative path the emails link to.

// Notifications that must never surface in the inbox. `magic_link` is a
// security/access send (a single-use sign-in URL) — it belongs in email only,
// not a persistent, re-openable list. Everything else is fair game.
export const INBOX_HIDDEN_TEMPLATES: ReadonlySet<TemplateName> = new Set<TemplateName>([
  "magic_link",
]);

export function isInboxVisibleTemplate(name: string): name is TemplateName {
  return (
    (TEMPLATE_NAMES as readonly string[]).includes(name) &&
    !INBOX_HIDDEN_TEMPLATES.has(name as TemplateName)
  );
}

// String list of inbox-visible templates, for the `templateName: { in }`
// filter in inbox queries. Keeping the filter on the DB side means the
// unread count and the rendered list agree on which rows count.
export const INBOX_VISIBLE_TEMPLATE_NAMES: string[] = TEMPLATE_NAMES.filter(
  (t) => !INBOX_HIDDEN_TEMPLATES.has(t),
);

export type InboxItem = {
  id: string;
  templateName: TemplateName;
  title: string;
  body: string;
  // Relative app path to open on click (e.g. "/payments/<id>"), or null when
  // the notification has no actionable destination.
  href: string | null;
  // The RAW dispatcher path suffix behind `href` (e.g. "t/messages/<id>"),
  // before web translation — the same value the push payload carries, handed
  // over unmodified so every consumer shares one destination model.
  deepLink: string | null;
  // Counterpart display name for deep links landing on a dynamic-segment
  // screen the id alone can't label (chat threads). Mirrors the push
  // payload's `deepLinkName`; null for templates that don't need it.
  deepLinkName: string | null;
  createdAt: Date;
  read: boolean;
};

// The minimal notification shape the renderer needs. Matches a Prisma
// `notification` row; callers pass the row straight through.
export type InboxNotificationRow = {
  id: string;
  teacherId: string;
  templateName: string;
  bookingId: string | null;
  paymentId: string | null;
  metadata: Prisma.JsonValue | null;
  readAt: Date | null;
  createdAt: Date;
};

// Turn the dispatcher's relative path suffix (the same one email/push use for
// their action link, e.g. "payments/<id>") into an in-app href.
//
// Not a plain "/" + suffix: the chat/class/book suffixes are role-prefixed
// (`t/…`, `s/…`) and have no such web route, so they go
// through webPathForDeepLink to reach their `/dashboard/*` / `/my-classes/*`
// equivalent. See web-deep-links.ts.
function toAppHref(deepLink: string | null): string | null {
  return webPathForDeepLink(deepLink);
}

// Render a single stored notification row into an inbox item. `teacherName`
// belongs to the notification's teacher; `recipientTimezone` belongs to the
// actual VIEWER (the teacher's zone for the teacher inbox, the student's own
// — falling back to the teacher's — for a student inbox), matching
// dispatcher.ts's buildVariables so a notification's copy never differs
// between the inbox and what was actually pushed/emailed. `locale` is the
// viewer's current UI language, doubling as the date-format locale.
//
// If the underlying entity a template references has since been deleted (so
// `buildVariables` can't resolve), we still return an item — a generic,
// link-less placeholder — so the row never silently vanishes from the list
// while still being counted as unread.
export async function renderInboxItem(
  prisma: PrismaClient,
  notification: InboxNotificationRow,
  ctx: {
    teacherName: string;
    recipientTimezone: string;
    // The teacher's own zone — needed as the "other participant" zone for
    // student-viewer inbox rows (see BuildContext.teacherTimezone in
    // dispatcher.ts). Optional: omitted callers just don't get the
    // dual-zone secondary line, no crash.
    teacherTimezone?: string;
    locale: AppLocale;
    // Optional shared caches for batch rendering (the inbox list passes one
    // preloaded map of each across the whole page to avoid an N+1 of
    // booking/payment/package lookups). Omitted for single-item rendering.
    bookingCache?: BookingCache;
    paymentCache?: PaymentCache;
    packageCache?: PackageCache;
  },
): Promise<InboxItem | null> {
  if (!isInboxVisibleTemplate(notification.templateName)) return null;
  const templateName = notification.templateName as TemplateName;
  const languageCode = localeToLanguageCode(ctx.locale);

  const base = {
    id: notification.id,
    templateName,
    createdAt: notification.createdAt,
    read: notification.readAt != null,
  };

  const built = await buildVariables(prisma, {
    templateName,
    notification: {
      id: notification.id,
      teacherId: notification.teacherId,
      bookingId: notification.bookingId,
      paymentId: notification.paymentId,
      metadata: notification.metadata,
    },
    teacherName: ctx.teacherName,
    recipientTimezone: ctx.recipientTimezone,
    teacherTimezone: ctx.teacherTimezone,
    recipientLocale: ctx.locale,
    // Inbox rendering never mints fresh signed download URLs; the builder
    // falls back to its path-suffix link, which the inbox links to anyway.
    storage: null,
    bookingCache: ctx.bookingCache,
    paymentCache: ctx.paymentCache,
    packageCache: ctx.packageCache,
  });

  if (!built.ok) {
    const es = languageCode === "es_MX";
    return {
      ...base,
      title: es ? "Notificación" : "Notification",
      body: "",
      href: null,
      deepLink: null,
      deepLinkName: null,
    };
  }

  const rendered = renderPush(templateName, languageCode, built.variables);
  return {
    ...base,
    title: rendered.title,
    body: rendered.body,
    href: toAppHref(rendered.deepLink),
    deepLink: rendered.deepLink,
    deepLinkName: rendered.deepLinkName ?? null,
  };
}
