import Link from "next/link";
import { BellOff, CheckCheck, ChevronRight, Settings2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { SubmitButton } from "@/components/ui/submit-button";
import { requireTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import {
  INBOX_RETENTION_DAYS,
  getTeacherInboxUnreadCount,
  listTeacherInboxPage,
} from "@/lib/notifications/inbox-queries";
import {
  INBOX_FILTERS,
  inboxHref,
  resolveInboxCursor,
  resolveInboxFilter,
  type InboxFilter,
} from "@/lib/notifications/inbox-view";
import { cn } from "@/lib/utils";
import { markAllReadAction } from "./actions";
import { NotificationList } from "./notification-list";

// Teacher notifications inbox. A durable, in-app record of every event the
// teacher would otherwise only catch by email — so a missed email (e.g. a
// student's Wise payment waiting to be activated) is still visible and
// actionable here. Reads the same notification rows the dispatcher writes.
//
// THE SCREEN'S JOB IS TRIAGE, and the layout follows from that: two views
// (everything / only what she has not opened), a day-grouped list whose rows
// say at a glance which KIND of event they are, and a way to reach past the
// first page — the list used to stop dead at fifty rows with nothing saying
// so, which in a 90-day window meant older notifications were simply
// unreachable.
export const dynamic = "force-dynamic";

/**
 * How many rows a page of the inbox holds.
 *
 * Smaller than the read-model's own 50 on purpose. Every row is rendered
 * through the dispatcher's variable builder, several templates still issue
 * their own booking lookup, and this page is `force-dynamic` — so the page
 * size is a latency budget, not a layout choice. Twenty-five is roughly two
 * screens of scrolling, and the pager below the list is what reaches the rest.
 */
const PAGE_SIZE = 25;

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [teacher, locale, t, params] = await Promise.all([
    requireTeacher(),
    getPreferredLocale(),
    getT(),
    searchParams,
  ]);

  const filter = resolveInboxFilter(params.show);
  const cursor = resolveInboxCursor(params.cursor);
  const now = new Date();

  const [page, unreadCount] = await Promise.all([
    listTeacherInboxPage(teacher.id, locale, {
      take: PAGE_SIZE,
      cursor,
      unreadOnly: filter === "unread",
    }),
    // Counted in the DB, not from the page slice — otherwise "mark all as
    // read" and the tab count disagree with the nav bell badge (which uses
    // this same count) the moment an unread row falls past the first page.
    getTeacherInboxUnreadCount(teacher.id),
  ]);

  const currentHref = inboxHref(filter, cursor);
  // The view without its cursor: where "mark all as read" comes back to, and
  // where the pager's "back to newest" goes.
  const viewHref = inboxHref(filter);
  const isEmpty = page.items.length === 0;

  return (
    <PageShell width="reading">
      <PageHeader
        title={t("web.notifications.title")}
        description={t("web.notifications.subtitle")}
        actions={
          <>
            {unreadCount > 0 && (
              <form action={markAllReadAction}>
                <input type="hidden" name="return" value={viewHref} />
                <SubmitButton variant="outline" size="sm">
                  <CheckCheck className="size-4" aria-hidden />
                  {t("web.notifications.markAllRead")}
                </SubmitButton>
              </form>
            )}
            {/* The page a teacher goes looking for the moment a notification
                annoys her. Putting it here saves the trip through Settings. */}
            <Button asChild variant="ghost" size="sm">
              <Link href="/settings/notifications">
                <Settings2 className="size-4" aria-hidden />
                {t("web.notifications.settingsLink")}
              </Link>
            </Button>
          </>
        }
      />

      <InboxViews filter={filter} unreadCount={unreadCount} t={t} />

      {isEmpty ? (
        <EmptyState
          icon={BellOff}
          title={
            filter === "unread"
              ? t("web.notifications.emptyUnreadTitle")
              : t("web.notifications.emptyTitle")
          }
          description={
            filter === "unread"
              ? t("web.notifications.emptyUnreadBody", { days: INBOX_RETENTION_DAYS })
              : t("web.notifications.emptyBody")
          }
          action={
            filter === "unread" ? (
              <Button asChild variant="outline" size="sm">
                <Link href={inboxHref("all")}>{t("web.notifications.filter.all")}</Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <Card>
          <NotificationList
            items={page.items}
            roundedBottom={!page.nextCursor && !cursor}
            ctx={{
              locale,
              t,
              timezone: teacher.timezone,
              now,
              returnHref: currentHref,
            }}
          />
          {(page.nextCursor || cursor) && (
            <nav
              aria-label={t("web.notifications.pagerLabel")}
              // `justify-end` when there is nothing on the left, rather than a
              // spacer element: an empty <span> to push one link across is a
              // node a screen reader still walks past.
              className={cn(
                "flex flex-wrap items-center gap-3 border-t px-4 py-3 lg:px-5",
                cursor ? "justify-between" : "justify-end",
              )}
            >
              {/* Cursor paging goes one way. A "newer" link would need the
                  trail of every cursor visited to get back, and "back to
                  newest" is the move she actually wants after reading down. */}
              {cursor && (
                <Link
                  href={viewHref}
                  className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
                >
                  {t("web.notifications.newest")}
                </Link>
              )}
              {page.nextCursor && (
                <Link
                  href={inboxHref(filter, page.nextCursor)}
                  rel="next"
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                >
                  {t("web.notifications.older")}
                  <ChevronRight className="size-4" aria-hidden />
                </Link>
              )}
            </nav>
          )}
        </Card>
      )}

      {/* Why the list ends where it does. Without this the window reads as a
          bug — notifications she remembers receiving are simply not here. */}
      <p className="text-sm text-muted-foreground">
        {t("web.notifications.retention", { days: INBOX_RETENTION_DAYS })}
      </p>
    </PageShell>
  );
}

/**
 * The two views of the inbox.
 *
 * LINKS, NOT A TAB WIDGET — the same call `ClassesToolbar` makes, for the same
 * reason: each one is a different server-rendered list at its own URL, so it
 * is navigation. A Radix `Tabs` would need client JavaScript to do less (no
 * deep link, no back button, no middle-click) and would announce a tablist to
 * a screen reader with no tab panel behind it. `aria-current="page"` is what
 * carries the selected state.
 */
function InboxViews({
  filter,
  unreadCount,
  t,
}: {
  filter: InboxFilter;
  unreadCount: number;
  t: TFunction;
}) {
  const LABEL: Record<InboxFilter, string> = {
    all: t("web.notifications.filter.all"),
    unread: t("web.notifications.filter.unread"),
  };

  return (
    <nav
      aria-label={t("web.notifications.viewsLabel")}
      className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-md bg-muted p-1"
    >
      {INBOX_FILTERS.map((value) => {
        const active = value === filter;
        return (
          <Link
            key={value}
            href={inboxHref(value)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
              active
                ? "bg-background text-foreground shadow-brand-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {LABEL[value]}
            {/* Only on the view whose count is a job to do. A total beside
                "All" would be a number the list underneath already shows. */}
            {value === "unread" && unreadCount > 0 && <Badge>{unreadCount}</Badge>}
          </Link>
        );
      })}
    </nav>
  );
}
