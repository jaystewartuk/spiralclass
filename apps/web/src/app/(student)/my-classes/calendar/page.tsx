import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { FALLBACK_TIMEZONE, minutesOfDayInTz } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { requireStudent } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { studentIdentityIds } from "@/lib/students/identity";
import { toYMD } from "@/lib/tz";
import { formatZonedTime } from "@/lib/date-display";
import { trackServerEvent } from "@/lib/analytics/posthog";
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
import { ClassesViewToggle } from "../classes-view-toggle";

// Recognized calendar_viewed entry points — anything else (a typed URL, a
// bookmark, a browser-restored tab) falls back to "direct". Threaded through
// `ref` on every internal calendar link (view switcher, this page's own
// toggle) so switching month/week/day mid-visit keeps attributing to how the
// student actually arrived, instead of drifting to "direct". "nav" = the top
// nav bar's "Calendario" link; "list_toggle" = the List/Calendar switch on
// this page and on /my-classes.
const ENTRY_POINTS = ["nav", "list_toggle"] as const;
type EntryPoint = (typeof ENTRY_POINTS)[number] | "direct";
function parseEntryPoint(v: string | undefined): EntryPoint {
  return (ENTRY_POINTS as readonly string[]).includes(v ?? "") ? (v as EntryPoint) : "direct";
}

// Student calendar — their classes across every teacher on one grid, in month /
// week / day views. Bookings are bucketed into DAY CELLS using the student's
// own zone (`anchorTz`, the same zone the month/week/day grid itself is built
// from) — bucketing by each booking's teacher zone instead (as this page used
// to) could disagree with the grid near a month/day boundary and silently drop
// the event from every visible month (fetched via FETCH_PAD_MS, then filtered
// out by `!gridDays.has(ymd)`). The displayed TIME label still shows the
// teacher's wall clock as primary — only which cell an event lands in changed
// — with the student's own zone appended when it resolves to a different clock.

const FETCH_PAD_MS = 36 * 60 * 60 * 1000;

type CalendarView = "month" | "week" | "day";

function parseView(v: string | undefined): CalendarView {
  if (v === "week" || v === "day") return v;
  return "month";
}

export default async function StudentCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; d?: string; v?: string; ref?: string }>;
}) {
  const student = await requireStudent();
  const locale = await getPreferredLocale();
  const t = await getT();
  const studentTz = student.timezone;
  const studentIds = await studentIdentityIds(student);
  const sp = await searchParams;
  const entryPoint = parseEntryPoint(sp.ref);
  trackServerEvent({
    name: "calendar_viewed",
    distinctId: student.id,
    properties: { surface: "web", entryPoint },
  });

  const now = new Date();
  // No explicit month? Anchor on the student's own zone when known, else fall
  // back to the platform default so "today" lands on a sensible day.
  const anchorTz = studentTz ?? FALLBACK_TIMEZONE;
  const todayYmd = toYMD(now, anchorTz);
  const view = parseView(sp.v);

  const { year, month0 } = parseMonthParam(sp.m) ?? monthOf(todayYmd);
  const anchorYmd = sp.d && isValidYmd(sp.d) ? sp.d : todayYmd;

  // Date range to fetch for the current view.
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
      studentId: { in: studentIds },
      scheduledStart: { gte: fetchStart, lte: fetchEnd },
    },
    orderBy: { scheduledStart: "asc" },
    include: { teacher: { select: { name: true, timezone: true } } },
  });

  // Month view restricts to the visible grid; week/day let the components filter.
  const grid = view === "month" ? buildClassMonthGrid(year, month0) : [];
  const gridDays = new Set(grid.map((g) => g.ymd));

  const events: CalendarEvent[] = [];
  for (const b of bookings) {
    const teacherTz = b.teacher.timezone;
    // Cell placement uses the viewer's own zone (matches gridDays/todayYmd,
    // both built from anchorTz) — see the file-header comment.
    const ymd = toYMD(b.scheduledStart, anchorTz);
    if (view === "month" && !gridDays.has(ymd)) continue;

    // Dual-timezone display standard, adapted for grid-cell density: the
    // viewer's (student's) own time is primary. The teacher's time is
    // appended only when it actually differs — unlike the full standard
    // (always show both), a month/week grid cell has no room for a
    // redundant "10:00 · 10:00" on every event.
    const viewerTz = studentTz ?? teacherTz;
    let timeLabel = formatZonedTime(b.scheduledStart, viewerTz, locale);
    if (viewerTz !== teacherTz) {
      const theirs = formatZonedTime(b.scheduledStart, teacherTz, locale);
      if (theirs !== timeLabel) timeLabel = `${timeLabel} · ${theirs}`;
    }

    events.push({
      id: b.id,
      ymd,
      href: `/my-classes/${b.id}`,
      startUtc: b.scheduledStart,
      // Same zone as `ymd` — a time-grid view positions the event vertically
      // within its day cell using this, so it must agree with which day the
      // event was placed in.
      startMinutes: minutesOfDayInTz(b.scheduledStart, anchorTz),
      durationMinutes: Math.round((b.scheduledEnd.getTime() - b.scheduledStart.getTime()) / 60000),
      timeLabel,
      title: b.teacher.name,
      status: b.status,
    });
  }

  const selectedYmd =
    view === "month"
      ? resolveSelectedDay({ requested: sp.d, gridDays, todayYmd, year, month0 })
      : anchorYmd;

  const statusLabel = (s: string) => studentStatusLabel(s, t);
  // Where the current-time rule sits in the week/day grids, in the zone this
  // page builds every other date from.
  const nowMinutes = minutesOfDayInTz(now, anchorTz);

  // Carries the original entry_point through view-switch navigation so
  // calendar_viewed keeps attributing to how the student actually arrived
  // here, not "direct" on every month/week/day tap.
  const refParam = entryPoint === "direct" ? "" : `&ref=${entryPoint}`;
  const viewHref = (v: CalendarView) => {
    if (v === "month") return `/my-classes/calendar?v=month&m=${monthStr(year, month0)}${refParam}`;
    if (v === "week")
      return `/my-classes/calendar?v=week&m=${monthStr(year, month0)}&d=${anchorYmd}${refParam}`;
    return `/my-classes/calendar?v=day&m=${monthStr(year, month0)}&d=${anchorYmd}${refParam}`;
  };

  return (
    <PageShell width="wide">
      <PageHeader
        title={t("web.studentCalendar.title")}
        description={t("web.studentCalendar.subtitle")}
        actions={<ClassesViewToggle active="calendar" t={t} />}
      />

      {/* The same control as the teacher calendar's, from the same file. It was
          written out twice, identically, at a ~30px tap target — half the 44px
          D-140 asks for — and the two copies had already started to drift
          apart in their catalog keys while rendering the same three words. */}
      <CalendarViewSwitcher active={view} href={viewHref} t={t} />

      {view === "month" && (
        <CalendarMonth
          year={year}
          month0={month0}
          selectedYmd={selectedYmd}
          todayYmd={todayYmd}
          events={events}
          locale={locale}
          basePath="/my-classes/calendar"
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
          basePath="/my-classes/calendar"
          statusLabel={statusLabel}
          nowMinutes={nowMinutes}
          timeZone={anchorTz}
        />
      )}

      {view === "day" && (
        <CalendarDay
          ymd={anchorYmd}
          todayYmd={todayYmd}
          events={events}
          locale={locale}
          basePath="/my-classes/calendar"
          emptyDayText={t("calendar.emptyDay")}
          statusLabel={statusLabel}
          nowMinutes={nowMinutes}
          timeZone={anchorTz}
        />
      )}
    </PageShell>
  );
}

function studentStatusLabel(status: string, t: Awaited<ReturnType<typeof getT>>): string {
  switch (status) {
    case "scheduled":
      return t("web.studentCalendar.status.scheduled");
    case "completed":
      return t("booking.status.completed");
    case "canceled_by_student":
      return t("web.studentCalendar.status.canceledByStudent");
    case "canceled_by_teacher":
      return t("web.studentCalendar.status.canceledByTeacher");
    case "rescheduled":
      return t("booking.status.rescheduled");
    case "no_show":
      return t("web.studentCalendar.status.noShow");
    default:
      return status;
  }
}
