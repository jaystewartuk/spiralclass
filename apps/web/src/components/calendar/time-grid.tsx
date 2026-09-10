import Link from "next/link";
import { layoutOverlaps, visibleHourRange } from "@spiralclass/shared";
import type { AppLocale } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";
import { ymdToUtcNoon } from "@/lib/calendar-grid";
import { CurrentTimeLine } from "./current-time-line";
import type { CalendarEvent } from "./event";
import { styleFor } from "./status-style";

// Google-Calendar-style hour-axis grid shared by the week (7 day columns) and
// day (1 column) views. Each event is absolutely positioned by its start
// time-of-day and duration; overlapping classes split a day's width into
// side-by-side columns via the shared `layoutOverlaps` math. Timezone-agnostic:
// the page has already resolved each event's `startMinutes` in the display zone.

/**
 * The height of one hour row.
 *
 * RAISED FROM 48. A block is two lines — the time and who it is with — and
 * D-140 puts the floor for both at 15px, so two lines plus padding and a
 * border need about 60px. At 48 they did not fit, which is why a one-hour
 * class in the week view was rendering its student's name clipped through the
 * middle of the glyphs. The number follows the type, not the other way round;
 * the alternative was type below the floor, which is not available.
 */
const HOUR_PX = 64;

/** Under this many minutes a block cannot hold two lines, so it holds one. */
const TWO_LINE_MINUTES = 45;

export function TimeGrid({
  days,
  events,
  todayYmd,
  locale,
  dayHref,
  nowMinutes,
  timeZone,
  t,
}: {
  /** The day(s) to render as columns — 1 for the day view, 7 for the week. */
  days: { ymd: string }[];
  events: CalendarEvent[];
  todayYmd: string;
  locale: AppLocale;
  /** Link target for a day-column header (jumps to that day's view). */
  dayHref: (ymd: string) => string;
  /**
   * Minutes from local midnight, in the viewer's zone, at render time —
   * resolved by the page, which is the only layer that knows the zone. This is
   * the current-time rule's FIRST position; `timeZone` is what lets it keep
   * itself right afterwards (see CurrentTimeLine). Omit either to draw no rule.
   */
  nowMinutes?: number;
  /** The viewer's IANA zone — the same one `startMinutes` was resolved in. */
  timeZone?: string;
  t: TFunction;
}) {
  const { startHour, endHour } = visibleHourRange(events);
  const gridHeight = (endHour - startHour) * HOUR_PX;
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);

  const byDay = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const list = byDay.get(e.ymd) ?? [];
    list.push(e);
    byDay.set(e.ymd, list);
  }

  // The rule needs both halves: where it starts (server) and how to stay right
  // (the zone). Whether `now` falls inside the rendered hours is the
  // component's own business — after the first tick, it is the only thing that
  // knows what time it is.
  const drawsNowRule = nowMinutes !== undefined && timeZone !== undefined;

  const weekdayFmt = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" });

  // A one-column grid needs no column header: the range header directly above
  // it already names the day in full, and a "Tue / 1" chip beneath "Tuesday,
  // 1 September 2026" is the same fact twice — plus a link to the page you are
  // already on.
  const showDayHeaders = days.length > 1;

  return (
    <div className="bg-card shadow-brand-sm overflow-x-auto rounded-lg border">
      {/* The floor is for SEVEN columns. A one-column day grid already fits
          any viewport, and forcing 36rem on it would make the day view scroll
          sideways inside its own (narrower) column on a wide screen. */}
      <div className={cn("flex", days.length > 1 && "min-w-table")}>
        {/* Hour gutter */}
        <div className="bg-muted/30 w-16 shrink-0 border-r">
          {showDayHeaders && <div className="h-14 border-b" />}
          <div style={{ height: gridHeight }} className="relative">
            {hours.map((h, i) => (
              <div
                key={h}
                style={{ top: i * HOUR_PX }}
                // Sits just BELOW its own hour line rather than centred on it.
                // Centred, the first label was half outside the grid and had to
                // be blanked, which left the topmost hour — often the one
                // holding the first class of the day — as the only unlabelled
                // row on the axis.
                className="text-muted-foreground absolute right-2 pt-1 text-sm tabular-nums"
              >
                {String(h).padStart(2, "0")}:00
              </div>
            ))}
          </div>
        </div>

        {/* Day columns */}
        <div className="flex flex-1">
          {days.map((day) => {
            const isToday = day.ymd === todayYmd;
            const dayDate = ymdToUtcNoon(day.ymd);
            // 0=Mon … 6=Sun, from the same UTC-noon date the grid is built on.
            const isWeekend = [0, 6].includes(dayDate.getUTCDay());
            const laid = layoutOverlaps(
              (byDay.get(day.ymd) ?? []).map((e) => ({
                id: e.id,
                startMinutes: e.startMinutes,
                durationMinutes: e.durationMinutes,
                ev: e,
              })),
            );

            return (
              <div key={day.ymd} className="min-w-0 flex-1 border-r last:border-r-0">
                {showDayHeaders && (
                  <Link
                    href={dayHref(day.ymd)}
                    className={cn(
                      "hover:bg-muted flex h-14 flex-col items-center justify-center gap-0.5 border-b transition-colors",
                      isToday ? "bg-primary/10" : "text-muted-foreground",
                    )}
                  >
                    <span className="text-sm leading-none capitalize">
                      {weekdayFmt.format(dayDate)}
                    </span>
                    <span
                      className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-full text-sm leading-none font-semibold tabular-nums",
                        isToday ? "bg-primary text-primary-foreground" : "text-foreground",
                      )}
                    >
                      {dayDate.getUTCDate()}
                    </span>
                  </Link>
                )}
                <div
                  style={{ height: gridHeight }}
                  className={cn("relative", isWeekend && "bg-muted/20")}
                >
                  {/* Hour lines */}
                  {hours.map((h, i) => (
                    <div
                      key={h}
                      style={{ top: i * HOUR_PX }}
                      className="border-border/60 absolute inset-x-0 border-t"
                    />
                  ))}

                  {/* The current-time rule, on today's column only. */}
                  {isToday && drawsNowRule && (
                    <CurrentTimeLine
                      timeZone={timeZone}
                      initialMinutes={nowMinutes}
                      startHour={startHour}
                      endHour={endHour}
                      hourPx={HOUR_PX}
                      label={t("web.calendar.currentTime")}
                    />
                  )}

                  {/* Event blocks */}
                  {laid.map((l) => {
                    const top = ((l.startMinutes - startHour * 60) / 60) * HOUR_PX;
                    const rawHeight = ((l.layoutEnd - l.layoutStart) / 60) * HOUR_PX;
                    const height = Math.max(rawHeight - 2, 22);
                    const widthPct = 100 / l.columns;
                    const twoLine = l.ev.durationMinutes >= TWO_LINE_MINUTES;
                    return (
                      <Link
                        key={l.ev.id}
                        href={l.ev.href}
                        title={`${l.ev.timeLabel} · ${l.ev.title}`}
                        style={{
                          top,
                          height,
                          left: `calc(${l.column * widthPct}% + 2px)`,
                          width: `calc(${widthPct}% - 4px)`,
                        }}
                        className={cn(
                          "hover:shadow-brand-md absolute z-10 overflow-hidden rounded-md border border-l-4 px-1.5 py-0.5 text-sm leading-snug shadow-xs transition-shadow",
                          styleFor(l.ev.status).block,
                          // Too short for two lines: run them together so the
                          // student's name is still there rather than clipped
                          // out of a box that was never tall enough for it.
                          !twoLine && "flex items-center gap-1.5 py-0",
                        )}
                      >
                        <span className="block shrink-0 truncate font-semibold tabular-nums">
                          {l.ev.timeLabel}
                        </span>
                        <span className="block truncate">{l.ev.title}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
