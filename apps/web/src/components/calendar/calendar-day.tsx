import type { AppLocale } from "@/lib/i18n";
import { getT } from "@/lib/i18n";
import { monthStr, shiftDay, ymdToUtcNoon } from "@/lib/calendar-grid";
import { AgendaList } from "./agenda-list";
import { groupByDay, type CalendarEvent } from "./event";
import { CalendarRangeHeader } from "./calendar-range-header";
import { TimeGrid } from "./time-grid";

/**
 * One day, twice: the shape of it and the detail of it.
 *
 * It was the time grid alone, one column wide, stretched across the full
 * content width. At 1280px that made every class a 1,150px pale slab holding
 * two short words, an eight-hour axis of empty space beside it, and no room
 * anywhere for what the teacher actually came to check — how long the class
 * is and what state it is in. A grid is the right way to see a day's SHAPE
 * (where the gaps are, what overlaps) and the wrong way to read its CONTENT.
 *
 * So the grid keeps its job and gives up the width it was not using, and the
 * agenda takes the rest. On a phone they stack, agenda first: the list is what
 * you can actually read at 390px, and the grid below it is the overview.
 */
export async function CalendarDay({
  ymd,
  todayYmd,
  events,
  locale,
  basePath,
  emptyDayText,
  statusLabel,
  nowMinutes,
  timeZone,
}: {
  ymd: string;
  todayYmd: string;
  events: CalendarEvent[];
  locale: AppLocale;
  basePath: string;
  emptyDayText: string;
  statusLabel: (status: string) => string;
  nowMinutes?: number;
  timeZone?: string;
}) {
  const t = await getT();

  const dayLabel = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(ymdToUtcNoon(ymd));

  const prevYmd = shiftDay(ymd, -1);
  const nextYmd = shiftDay(ymd, 1);
  const dayNavHref = (d: string) => `${basePath}?v=day&m=${monthStr(...parseDay(d))}&d=${d}`;

  // The pages pad the fetch window by 36 hours on each side, so `events` can
  // hold yesterday's and tomorrow's classes too. The grid filters by column;
  // the agenda and the count have to filter for themselves.
  const dayEvents = groupByDay(events).get(ymd) ?? [];

  return (
    <div className="space-y-5">
      <CalendarRangeHeader
        title={dayLabel}
        titleClassName="capitalize"
        count={dayEvents.length}
        prev={{ href: dayNavHref(prevYmd), label: t("web.calendar.previousDay") }}
        next={{ href: dayNavHref(nextYmd), label: t("web.calendar.nextDay") }}
        todayHref={dayNavHref(todayYmd)}
        t={t}
      />

      {dayEvents.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-12 text-center text-sm">
          {emptyDayText}
        </p>
      ) : (
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          {/* Source order puts the AGENDA first, so a phone reads the list
              before the axis — the list is the part that is legible at 390px,
              and a 900px hour grid above it would be 900px of scrolling to
              reach the answer. `lg:order-*` then puts the axis back on the
              left of a wide screen, where a left-to-right reader looks for a
              time rail. */}
          <div className="lg:order-2 lg:min-w-0 lg:flex-1">
            <AgendaList events={dayEvents} statusLabel={statusLabel} t={t} />
          </div>
          <div className="lg:order-1 lg:w-80 lg:shrink-0">
            <TimeGrid
              days={[{ ymd }]}
              events={dayEvents}
              todayYmd={todayYmd}
              locale={locale}
              dayHref={dayNavHref}
              nowMinutes={nowMinutes}
              timeZone={timeZone}
              t={t}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function parseDay(ymd: string): [number, number] {
  const [y, m] = ymd.split("-").map(Number);
  return [y, m - 1];
}
