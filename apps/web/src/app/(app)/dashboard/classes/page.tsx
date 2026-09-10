import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { CalendarDays, FileWarning, History } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { GlanceRow } from "@/components/ui/glance-row";
import { CallCta } from "@/components/call-cta";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { timezoneCityLabel } from "@/lib/date-display";
import { toYMD, zonedWallClockToUtc } from "@/lib/tz";
import { shiftDay } from "@/lib/calendar-grid";
import {
  classesHref,
  normalizeClassSearch,
  resolveClassesScope,
  type ClassesScope,
} from "@/lib/classes-list";
import { ClassList, FlatClassList, RecentRow, type ClassListItem } from "./class-list";
import { ClassesToolbar } from "./classes-toolbar";

/**
 * The teacher's class roster.
 *
 * The screen answers, in this order, the three questions a teacher opens it
 * with: what is next, what still needs preparing, and what just happened. The
 * previous version answered none of them — it was two equally-weighted cards,
 * "Upcoming" and a 24-hour "Recent" that was empty most of the time and took
 * up a third of the page saying so.
 *
 * THREE THINGS ABOUT THE SHAPE, since each is a decision rather than a default:
 *
 *  1. TWO COLUMNS above `lg`. The list is the work; the counts and the recent
 *     outcomes are things she checks. They sit in an aside at a third of the
 *     width, which is also what stops the roster rendering in a 672px column
 *     with 380px of empty gutter on each side of a 1440px screen.
 *  2. THE PAST IS REACHABLE. It was not: the only history here was 24 hours
 *     wide, so a class cancelled the day before yesterday existed nowhere on
 *     this screen. `?show=past` is the whole non-scheduled history, newest
 *     first.
 *  3. "JUST FINISHED" IS ITS OWN STRIP. A class stays `scheduled` until the
 *     hourly sweep completes it (lib/inngest/functions/auto-complete-sweep.ts),
 *     so for up to an hour after it ends it is still in the scheduled set — and
 *     the old query, which filtered on status alone with no date bound, sorted
 *     it ASCENDING to the very top of "Upcoming" under a heading dated in the
 *     past. That hour is also the teacher's only window to record a no-show
 *     instead, so the fix is to name the strip rather than to hide it.
 *
 * Tenancy: every query is filtered by `teacherId` from auth.
 */

/** How far back the aside's activity feed looks. */
const RECENT_HOURS = 24;
/** How many outcomes that feed lists — it is a glance, not the history. */
const RECENT_LIMIT = 8;
/** Days the at-a-glance "next 7 days" figure covers. */
const WEEK_DAYS = 7;
/**
 * The upcoming list's ceiling. Generous enough that no real roster reaches it
 * (a teacher at ten classes a week is four months out), and the list says so
 * rather than truncating silently when one does.
 */
const UPCOMING_LIMIT = 100;
/** The past list's ceiling. Same contract: it says when it has more. */
const PAST_LIMIT = 50;
/** How many still-scheduled, already-ended classes the "just finished" strip shows. */
const JUST_FINISHED_LIMIT = 10;

const BOOKING_SELECT = {
  id: true,
  scheduledStart: true,
  scheduledEnd: true,
  status: true,
  student: { select: { name: true, timezone: true } },
  package: { select: { classDurationMin: true, template: { select: { name: true } } } },
  // The materials chip answers one question: does this class have ANY material
  // available? Count every class-scoped/private material (`materials` — a
  // booking-scoped LibraryMaterial, whether it's a file/link attachment OR
  // native written content) as well as every item attached from the reusable
  // library (`libraryMaterials`). Either source lighting up means the class has
  // materials.
  _count: { select: { materials: true, libraryMaterials: true } },
} satisfies Prisma.BookingSelect;

type BookingRow = Prisma.BookingGetPayload<{ select: typeof BOOKING_SELECT }>;

function toItem(booking: BookingRow): ClassListItem {
  return {
    id: booking.id,
    scheduledStart: booking.scheduledStart,
    scheduledEnd: booking.scheduledEnd,
    status: booking.status,
    studentName: booking.student.name,
    studentTimezone: booking.student.timezone,
    packageName: booking.package?.template?.name ?? null,
    durationMin: booking.package?.classDurationMin ?? null,
    hasMaterials: booking._count.materials > 0 || booking._count.libraryMaterials > 0,
  };
}

/** "No materials of either kind" — the filter behind the `materials` view and its count. */
const NO_MATERIALS = { materials: { none: {} }, libraryMaterials: { none: {} } } as const;

export default async function TeacherClassesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [teacher, locale, t, params] = await Promise.all([
    requireOnboardedTeacher(),
    getPreferredLocale(),
    getT(),
    searchParams,
  ]);

  const scope = resolveClassesScope(params.show);
  const search = normalizeClassSearch(params.q);
  const now = new Date();

  // Calendar-day boundaries in the TEACHER's zone, not a ±24h offset from now:
  // "today" is a day on her wall clock, and a DST transition makes one of those
  // 23 or 25 hours long.
  const todayYmd = toYMD(now, teacher.timezone);
  const todayEnd = zonedWallClockToUtc(shiftDay(todayYmd, 1), "00:00", teacher.timezone);
  const weekEnd = zonedWallClockToUtc(shiftDay(todayYmd, WEEK_DAYS), "00:00", teacher.timezone);
  const historyCutoff = new Date(now.getTime() - RECENT_HOURS * 60 * 60 * 1000);

  const mine = { teacherId: teacher.id };
  // THE SEARCH NARROWS THE LIST, NOT THE PAGE. The main column answers "which
  // classes", so it is filtered; the aside and the tab counts are standing
  // facts about her week and are not. A search for a name that matches nothing
  // otherwise reports "Missing materials 0", which is a different claim from
  // the true one and the opposite of reassuring.
  const searched = search
    ? { ...mine, student: { name: { contains: search, mode: "insensitive" as const } } }
    : mine;
  /** Scheduled and not yet over — the honest definition of "upcoming". */
  const stillAhead = { status: "scheduled" as const, scheduledEnd: { gte: now } };

  const listWhere: Record<ClassesScope, Prisma.BookingWhereInput> = {
    upcoming: { ...searched, ...stillAhead },
    materials: { ...searched, ...stillAhead, ...NO_MATERIALS },
    past: { ...searched, status: { not: "scheduled" } },
  };
  const listTake = (scope === "past" ? PAST_LIMIT : UPCOMING_LIMIT) + 1;

  const [listRows, justFinishedRows, weekStarts, needsMaterialsCount, recentRows] =
    await Promise.all([
      // One row over the ceiling, so "there are more" is something the page
      // knows rather than something it assumes from a full page of results.
      prisma.booking.findMany({
        where: listWhere[scope],
        orderBy: { scheduledStart: scope === "past" ? "desc" : "asc" },
        take: listTake,
        select: BOOKING_SELECT,
      }),
      // Only on the default view — it belongs to "upcoming" and would be a
      // non-sequitur above a search of the past.
      scope === "upcoming"
        ? prisma.booking.findMany({
            where: { ...searched, status: "scheduled", scheduledEnd: { lt: now } },
            orderBy: { scheduledStart: "desc" },
            take: JUST_FINISHED_LIMIT,
            select: BOOKING_SELECT,
          })
        : [],
      // Bounded by construction (one week of classes), so both figures come
      // from one round trip instead of two COUNTs over the same index.
      prisma.booking.findMany({
        where: { ...mine, ...stillAhead, scheduledStart: { lt: weekEnd } },
        select: { scheduledStart: true },
      }),
      prisma.booking.count({ where: { ...mine, ...stillAhead, ...NO_MATERIALS } }),
      prisma.booking.findMany({
        where: { ...mine, status: { not: "scheduled" }, scheduledStart: { gte: historyCutoff } },
        orderBy: { scheduledStart: "desc" },
        take: RECENT_LIMIT,
        select: BOOKING_SELECT,
      }),
    ]);

  const hasMore = listRows.length > listTake - 1;
  const items = listRows.slice(0, listTake - 1).map(toItem);
  const justFinished = justFinishedRows.map(toItem);
  const recent = recentRows.map(toItem);
  const todayCount = weekStarts.filter((b) => b.scheduledStart < todayEnd).length;
  const weekCount = weekStarts.length;

  const ctx = { locale, t, timezone: teacher.timezone, now };
  const zoneLabel = timezoneCityLabel(teacher.timezone);
  // The class actually running right now, if there is one. It can only be the
  // first row — the list is ascending and already excludes anything that has
  // ended, and a teacher cannot have two overlapping classes (the DB's
  // `bookings_no_overlap_buffered` exclusion constraint sees to that).
  const live =
    scope !== "past" && items[0] && items[0].scheduledStart <= now ? items[0] : undefined;

  return (
    <PageShell width="wide">
      <PageHeader
        title={t("classes.title")}
        description={t("web.dashboard.home.schedule.timesShownIn", { tz: zoneLabel })}
        actions={
          <>
            <Button asChild>
              <Link href="/dashboard/classes/book">{t("teacherBook.cta")}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/dashboard/calendar">{t("web.dashboard.classes.calendarView")}</Link>
            </Button>
          </>
        }
      />

      {/* `items-start` so a short aside does not stretch to the list's height
          and leave its last card floating in whitespace. */}
      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        <div className="space-y-4 lg:col-span-2">
          {/* A class in progress is the one thing on this screen that is not
              about planning, so it leads the column. It is also the only way
              to offer the action at all: every row in the list is already a
              link to its class, and a button inside a link is not something
              HTML can express. It appears only during the fifty minutes it is
              true. In the column rather than full-width above both, so the
              title and the button are a glance apart rather than a screen. */}
          {live && (
            <CallCta
              href={`/dashboard/classes/${live.id}/call`}
              title={live.studentName}
              subtitle={t("web.dashboard.classes.list.liveNow")}
              cta={t("call.join")}
            />
          )}

          <ClassesToolbar
            scope={scope}
            search={search}
            needsMaterialsCount={needsMaterialsCount}
            t={t}
          />

          {/* Above the list rather than in the aside, which is where it
              otherwise belongs: the aside stacks BELOW the roster on a phone,
              and the hour in which this strip exists is the only hour in which
              a no-show can still be recorded instead of a completion. Lighter
              than the roster card, because it resolves itself. */}
          {justFinished.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base" as="h2">
                  {t("web.dashboard.classes.list.justFinished")}
                </CardTitle>
                <CardDescription>
                  {t("web.dashboard.classes.list.justFinishedHelp")}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <FlatClassList items={justFinished} ctx={ctx} />
              </CardContent>
            </Card>
          )}

          {/* No card header on the list: the toolbar above it already names
              the view, and a "Upcoming" title directly under an "Upcoming" tab
              is the same word twice. The day headings carry the structure. */}
          {items.length === 0 ? (
            <ListEmptyState scope={scope} search={search} t={t} />
          ) : (
            <Card>
              <CardContent className="p-0">
                <ClassList
                  items={items}
                  ctx={ctx}
                  showStatus={scope === "past"}
                  featureFirst={scope !== "past"}
                  roundedBottom={!hasMore}
                />
                {hasMore && (
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-4 lg:px-6">
                    <p className="text-sm text-muted-foreground">
                      {t("web.dashboard.classes.list.more", { shown: items.length })}
                    </p>
                    <Button asChild variant="outline" size="sm">
                      <Link href="/dashboard/calendar">
                        {t("web.dashboard.classes.calendarView")}
                      </Link>
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <aside className="space-y-6">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-lg" as="h2">
                {t("web.dashboard.classes.list.glance.title")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3">
                <GlanceRow
                  label={t("web.dashboard.classes.list.glance.today")}
                  value={todayCount}
                />
                <GlanceRow label={t("web.dashboard.classes.list.glance.week")} value={weekCount} />
                <GlanceRow
                  label={t("web.dashboard.classes.list.glance.materials")}
                  value={needsMaterialsCount}
                  tone="warning"
                  href={classesHref("materials", search)}
                />
              </dl>
            </CardContent>
          </Card>

          {/* Absent, not empty. A card whose entire content is "No activity in
              this period" is furniture — it was a full-width one of those at
              the foot of the old page, and putting the same sentence in the
              aside would only make it smaller. The feed appears the first time
              something lands in it, which is the first time it means anything. */}
          {recent.length > 0 && (
            <Card>
              <CardHeader className="pb-4">
                <CardTitle className="text-lg" as="h2">
                  {t("web.dashboard.classes.list.recent.title")}
                </CardTitle>
                <CardDescription>
                  {t("web.dashboard.classes.list.recent.help", { hours: RECENT_HOURS })}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <ul className="divide-y divide-border border-t">
                  {recent.map((item) => (
                    <li key={item.id}>
                      <RecentRow item={item} ctx={ctx} />
                    </li>
                  ))}
                </ul>
                <div className="px-4 py-4 lg:px-6">
                  <Button asChild variant="outline" size="sm">
                    <Link href={classesHref("past")}>{t("home.viewAll")}</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </PageShell>
  );
}

/**
 * The four ways this list can be empty, each said in its own words.
 *
 * A search that found nothing is not the same event as a roster with nothing
 * in it, and "No upcoming classes" under a search for "Marcela" reads as a
 * data loss rather than a filter.
 */
function ListEmptyState({
  scope,
  search,
  t,
}: {
  scope: ClassesScope;
  search: string;
  t: Awaited<ReturnType<typeof getT>>;
}) {
  if (search) {
    return (
      <EmptyState
        icon={CalendarDays}
        title={t("web.dashboard.classes.list.empty.searchTitle", { query: search })}
        description={t("web.dashboard.classes.list.empty.searchBody")}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href={classesHref(scope)}>{t("web.dashboard.classes.list.search.clear")}</Link>
          </Button>
        }
      />
    );
  }

  if (scope === "materials") {
    return (
      <EmptyState
        icon={FileWarning}
        title={t("web.dashboard.classes.list.empty.materialsTitle")}
        description={t("web.dashboard.classes.list.empty.materialsBody")}
      />
    );
  }

  if (scope === "past") {
    return (
      <EmptyState
        icon={History}
        title={t("web.dashboard.classes.list.empty.pastTitle")}
        description={t("web.dashboard.classes.list.empty.pastBody")}
      />
    );
  }

  return (
    <EmptyState
      icon={CalendarDays}
      title={t("web.dashboard.classes.list.empty.upcomingTitle")}
      description={
        <>
          {t("web.dashboard.classes.noneScheduled")}{" "}
          <Link href="/settings/availability" className="underline">
            {t("web.dashboard.classes.workingHoursLink")}
          </Link>
          .
        </>
      }
      action={
        <Button asChild size="sm">
          <Link href="/dashboard/classes/book">{t("teacherBook.cta")}</Link>
        </Button>
      }
    />
  );
}
