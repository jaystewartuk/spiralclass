import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { prisma } from "@/lib/prisma";
import { minutesOfDayInTz } from "@spiralclass/shared";
import { toYMD } from "@/lib/tz";
import { formatZonedTime } from "@/lib/date-display";
import {
  buildClassMonthGrid,
  buildWeekDays,
  isValidYmd,
  monthOf,
  monthStr,
  parseMonthParam,
  resolveSelectedDay,
  ymdToUtcNoon,
} from "@/lib/calendar-grid";
import { CalendarMonth } from "@/components/calendar/calendar-month";
import type { CalendarEvent } from "@/components/calendar/event";
import { CalendarWeek } from "@/components/calendar/calendar-week";
import { CalendarDay } from "@/components/calendar/calendar-day";
import { CalendarViewSwitcher } from "@/components/calendar/calendar-view-switcher";
import { Button } from "@/components/ui/button";

// Teacher calendar — month / week / day views of every class. Read-only and
// schema-free: renders the same `bookings` rows on different grids.

const FETCH_PAD_MS = 36 * 60 * 60 * 1000;

type CalendarView = "month" | "week" | "day";

function parseView(v: string | undefined): CalendarView {
  if (v === "week" || v === "day") return v;
  return "month";
}

export default async function TeacherCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; d?: string; v?: string }>;
}) {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();
  const tz = teacher.timezone;
  const sp = await searchParams;

  const now = new Date();
  const todayYmd = toYMD(now, tz);
  const view = parseView(sp.v);

  // Resolve the anchor date (for week/day views) and month (for month view).
  const { year, month0 } = parseMonthParam(sp.m) ?? monthOf(todayYmd);
  const anchorYmd = sp.d && isValidYmd(sp.d) ? sp.d : todayYmd;

  // Build the date range that needs to be fetched for the current view.
  let fetchStart: Date;
  let fetchEnd: Date;
  if (view === "month") {
    const grid = buildClassMonthGrid(year, month0);
    fetchStart = new Date(ymdToUtcNoon(grid[0].ymd).getTime() - FETCH_PAD_MS);
    fetchEnd = new Date(ymdToUtcNoon(grid[grid.length - 1].ymd).getTime() + FETCH_PAD_MS);
  } else if (view === "week") {
    const days = buildWeekDays(anchorYmd);
    fetchStart = new Date(ymdToUtcNoon(days[0].ymd).getTime() - FETCH_PAD_MS);
    fetchEnd = new Date(ymdToUtcNoon(days[6].ymd).getTime() + FETCH_PAD_MS);
  } else {
    fetchStart = new Date(ymdToUtcNoon(anchorYmd).getTime() - FETCH_PAD_MS);
    fetchEnd = new Date(ymdToUtcNoon(anchorYmd).getTime() + FETCH_PAD_MS);
  }

  const bookings = await prisma.booking.findMany({
    where: {
      teacherId: teacher.id,
      scheduledStart: { gte: fetchStart, lte: fetchEnd },
    },
    orderBy: { scheduledStart: "asc" },
    include: { student: { select: { name: true, timezone: true } } },
  });

  const events: CalendarEvent[] = bookings.map((b) => {
    // Dual-timezone display standard, adapted for grid-cell density: the
    // teacher viewer's own time is primary (already `tz`). The student's
    // time is appended only when it actually differs — see the student
    // calendar's matching comment (my-classes/calendar/page.tsx).
    let timeLabel = formatZonedTime(b.scheduledStart, tz, locale);
    const studentTz = b.student.timezone;
    if (studentTz && studentTz !== tz) {
      const theirs = formatZonedTime(b.scheduledStart, studentTz, locale);
      if (theirs !== timeLabel) timeLabel = `${timeLabel} · ${theirs}`;
    }
    return {
      id: b.id,
      ymd: toYMD(b.scheduledStart, tz),
      href: `/dashboard/classes/${b.id}`,
      startUtc: b.scheduledStart,
      startMinutes: minutesOfDayInTz(b.scheduledStart, tz),
      durationMinutes: Math.round((b.scheduledEnd.getTime() - b.scheduledStart.getTime()) / 60000),
      timeLabel,
      title: b.student.name,
      status: b.status,
    };
  });

  // Month view: resolve selected day for the agenda panel.
  const grid = view === "month" ? buildClassMonthGrid(year, month0) : [];
  const gridDays = new Set(grid.map((g) => g.ymd));
  const selectedYmd =
    view === "month"
      ? resolveSelectedDay({ requested: sp.d, gridDays, todayYmd, year, month0 })
      : anchorYmd;

  // Where the current-time rule sits in the week/day grids. Resolved here
  // because this is the only layer that knows the teacher's zone.
  const nowMinutes = minutesOfDayInTz(now, tz);

  const viewHref = (v: CalendarView) => {
    if (v === "month") return `/dashboard/calendar?v=month&m=${monthStr(year, month0)}`;
    if (v === "week")
      return `/dashboard/calendar?v=week&m=${monthStr(year, month0)}&d=${anchorYmd}`;
    return `/dashboard/calendar?v=day&m=${monthStr(year, month0)}&d=${anchorYmd}`;
  };

  const statusLabel = (s: string) => teacherStatusLabel(s, t);

  return (
    <PageShell width="wide" className="py-8 lg:py-10">
      <PageHeader
        title={t("calendar.title")}
        description={t("web.dashboard.calendar.yourClassesInZone", { tz })}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/classes">{t("web.dashboard.calendar.list")}</Link>
            </Button>
            <Button asChild size="sm">
              <Link href={`/dashboard/classes/book?date=${selectedYmd}`}>
                {t("teacherBook.cta")}
              </Link>
            </Button>
          </>
        }
      />

      {/* The view switcher sits on its own row rather than in the header's
          actions. It is not an action on the page, it IS the page — putting it
          beside "Book a class" made a three-segment control, a secondary link
          and a primary button compete on one line, and at 768px that line wrapped
          into an unreadable pile. */}
      <CalendarViewSwitcher active={view} href={viewHref} t={t} />

      {view === "month" && (
        <CalendarMonth
          year={year}
          month0={month0}
          selectedYmd={selectedYmd}
          todayYmd={todayYmd}
          events={events}
          locale={locale}
          basePath="/dashboard/calendar"
          statusLabel={statusLabel}
          emptyDayText={t("calendar.emptyDay")}
        />
      )}

      {view === "week" && (
        <CalendarWeek
          anchorYmd={anchorYmd}
          todayYmd={todayYmd}
          events={events}
          locale={locale}
          basePath="/dashboard/calendar"
          statusLabel={statusLabel}
          nowMinutes={nowMinutes}
          timeZone={tz}
        />
      )}

      {view === "day" && (
        <CalendarDay
          ymd={anchorYmd}
          todayYmd={todayYmd}
          events={events}
          locale={locale}
          basePath="/dashboard/calendar"
          emptyDayText={t("calendar.emptyDay")}
          statusLabel={statusLabel}
          nowMinutes={nowMinutes}
          timeZone={tz}
        />
      )}
    </PageShell>
  );
}

function teacherStatusLabel(status: string, t: TFunction): string {
  const map: Record<string, string> = {
    scheduled: t("booking.status.scheduled"),
    completed: t("web.dashboard.calendar.status.completed"),
    canceled_by_student: t("web.dashboard.calendar.status.canceledByStudent"),
    canceled_by_teacher: t("web.dashboard.calendar.status.canceledByTeacher"),
    rescheduled: t("booking.status.rescheduled"),
    no_show: t("booking.status.no_show"),
  };
  return map[status] ?? status;
}
