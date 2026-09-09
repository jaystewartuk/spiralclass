import type { AppLocale } from "@/lib/i18n";
import { getT } from "@/lib/i18n";
import { buildWeekDays, monthStr, shiftDay, ymdToUtcNoon } from "@/lib/calendar-grid";
import type { CalendarEvent } from "./event";
import { CalendarLegend } from "./calendar-legend";
import { CalendarRangeHeader } from "./calendar-range-header";
import { TimeGrid } from "./time-grid";

export async function CalendarWeek({
  anchorYmd,
  todayYmd,
  events,
  locale,
  basePath,
  statusLabel,
  nowMinutes,
  timeZone,
}: {
  /** Any day in the week to display. The component derives Mon–Sun from it. */
  anchorYmd: string;
  todayYmd: string;
  events: CalendarEvent[];
  locale: AppLocale;
  basePath: string;
  statusLabel: (status: string) => string;
  nowMinutes?: number;
  timeZone?: string;
}) {
  const t = await getT();
  const days = buildWeekDays(anchorYmd);

  const monday = days[0].ymd;
  const sunday = days[6].ymd;
  const prevMonday = shiftDay(monday, -7);
  const nextMonday = shiftDay(monday, 7);

  const weekLabel = (() => {
    const startFmt = new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
    }).format(ymdToUtcNoon(monday));
    const endFmt = new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(ymdToUtcNoon(sunday));
    return `${startFmt} – ${endFmt}`;
  })();

  const weekNavHref = (anchor: string) =>
    `${basePath}?v=week&m=${monthStr(...parseAnchor(anchor))}&d=${anchor}`;

  const dayNavHref = (ymd: string) =>
    `${basePath}?v=day&m=${monthStr(...parseAnchor(ymd))}&d=${ymd}`;

  // The fetch window is padded by a day and a half on each side (the pages'
  // FETCH_PAD_MS), so `events` can carry a class from the neighbouring week.
  // Counting it would put a number in the header that no cell on screen
  // accounts for.
  const weekDays = new Set(days.map((d) => d.ymd));
  const weekCount = events.filter((e) => weekDays.has(e.ymd)).length;

  return (
    <div className="space-y-5">
      <CalendarRangeHeader
        title={weekLabel}
        count={weekCount}
        prev={{ href: weekNavHref(prevMonday), label: t("web.calendar.previousWeek") }}
        next={{ href: weekNavHref(nextMonday), label: t("web.calendar.nextWeek") }}
        todayHref={weekNavHref(todayYmd)}
        t={t}
      />

      <TimeGrid
        days={days}
        events={events}
        todayYmd={todayYmd}
        locale={locale}
        dayHref={dayNavHref}
        nowMinutes={nowMinutes}
        timeZone={timeZone}
        t={t}
      />

      <CalendarLegend statusLabel={statusLabel} t={t} />
    </div>
  );
}

function parseAnchor(ymd: string): [number, number] {
  const [y, m] = ymd.split("-").map(Number);
  return [y, m - 1];
}
