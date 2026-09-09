import Link from "next/link";
import type { AppLocale } from "@/lib/i18n";
import { getT } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";
import {
  buildClassMonthGrid,
  firstOfMonth,
  monthStr,
  shiftMonth,
  ymdToUtcNoon,
} from "@/lib/calendar-grid";
import { AgendaList } from "./agenda-list";
import { DayCell } from "./day-cell";
import { CalendarLegend } from "./calendar-legend";
import { CalendarRangeHeader } from "./calendar-range-header";
import { groupByDay, type CalendarEvent } from "./event";
import { styleFor } from "./status-style";

export async function CalendarMonth({
  year,
  month0,
  selectedYmd,
  todayYmd,
  events,
  locale,
  basePath,
  statusLabel,
  emptyDayText,
}: {
  year: number;
  month0: number;
  selectedYmd: string;
  todayYmd: string;
  events: CalendarEvent[];
  locale: AppLocale;
  basePath: string;
  statusLabel: (status: string) => string;
  emptyDayText: string;
}) {
  const t = await getT();
  const grid = buildClassMonthGrid(year, month0);
  const byDay = groupByDay(events);

  const prev = shiftMonth(year, month0, -1);
  const next = shiftMonth(year, month0, 1);
  const monthLabel = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(ymdToUtcNoon(firstOfMonth(year, month0)));

  // Monday-first weekday headers, derived from a known Monday (2024-01-01).
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(
      ymdToUtcNoon(`2024-01-0${i + 1}`),
    ),
  );

  const dayHref = (g: { ymd: string; monthStr: string }) =>
    `${basePath}?m=${g.monthStr}&d=${g.ymd}`;
  const monthHref = (m: { year: number; month0: number }) =>
    `${basePath}?m=${monthStr(m.year, m.month0)}`;

  const selectedEvents = byDay.get(selectedYmd) ?? [];
  const selectedLabel = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(ymdToUtcNoon(selectedYmd));

  // Counted over the month itself, not the grid: the leading spill-over week
  // belongs to the month before, and including its classes would make the
  // header disagree with the month the header names.
  const monthPrefix = monthStr(year, month0);
  const monthCount = events.filter((e) => e.ymd.startsWith(monthPrefix)).length;

  // The accessible name of each cell, e.g. "Mon, 5 May — 2 classes".
  const dayLabelFmt = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  return (
    <div className="space-y-5">
      <CalendarRangeHeader
        title={monthLabel}
        titleClassName="capitalize"
        count={monthCount}
        prev={{ href: monthHref(prev), label: t("web.calendar.previousMonth") }}
        next={{ href: monthHref(next), label: t("web.calendar.nextMonth") }}
        todayHref={basePath}
        t={t}
      />

      <div className="overflow-hidden rounded-lg border bg-card shadow-brand-sm">
        {/* Weekday header. Hidden from assistive tech: it labels the columns
            visually, but each cell's own accessible name already carries its
            weekday, so announcing this row is a second reading of the same
            fact with no structure to attach it to. */}
        <div
          aria-hidden
          className="grid grid-cols-7 border-b bg-muted/40 text-center text-sm font-medium text-muted-foreground"
        >
          {weekdays.map((w, i) => (
            <div key={i} className="truncate py-2 capitalize">
              {w}
            </div>
          ))}
        </div>

        {/* Day grid. The 1px gaps are drawn by the container's own background
            showing through, so there is exactly one rule between two cells
            rather than two borders meeting. */}
        <div className="grid grid-cols-7 gap-px bg-border">
          {grid.map((g) => {
            const dayEvents = byDay.get(g.ymd) ?? [];
            const isSelected = g.ymd === selectedYmd;
            const isToday = g.ymd === todayYmd;
            const countLabel =
              dayEvents.length === 0
                ? t("web.calendar.noClasses")
                : t("web.calendar.classCount", { count: dayEvents.length });
            return (
              <Link
                key={g.ymd}
                href={dayHref(g)}
                aria-current={isSelected ? "date" : undefined}
                aria-label={t("web.calendar.dayCellLabel", {
                  day: dayLabelFmt.format(ymdToUtcNoon(g.ymd)),
                  classes: countLabel,
                })}
                className={cn(
                  "relative flex min-h-cell flex-col p-1.5 text-left transition-colors sm:min-h-cell-lg sm:p-2",
                  // An INSET ring rather than the global outline. The grid is
                  // clipped by its rounded card, so an outline drawn outside a
                  // cell's box — which is what `outline-offset: 2px` asks for —
                  // is cut off on every edge cell, and no z-index fixes that.
                  // Same 3px, same colour, painted where it can be seen.
                  "focus-visible:z-10 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring",
                  // OPAQUE, all three of them. The 1px rules between cells are
                  // the container's `bg-border` showing through a `gap-px`, so
                  // a translucent cell fill does not composite over the card
                  // beneath it — it composites over that border grey, which is
                  // how `bg-muted/25` on the spill-over days was painting a
                  // solid slate slab across the bottom of the month.
                  g.inCurrentMonth ? "bg-card" : "bg-background",
                  "hover:bg-muted",
                  // Selection is the ring, not a tint, for the same reason.
                  isSelected && "z-10 ring-2 ring-inset ring-primary",
                )}
              >
                <DayCell
                  dayNum={String(Number(g.ymd.slice(-2)))}
                  isToday={isToday}
                  inCurrentMonth={g.inCurrentMonth}
                  moreWord={t("web.calendar.more")}
                  events={dayEvents.map((e) => ({
                    id: e.id,
                    timeLabel: e.timeLabel,
                    title: e.title,
                    statusLabel: statusLabel(e.status),
                    dotClass: styleFor(e.status).dot,
                    chipClass: styleFor(e.status).chip,
                  }))}
                />
              </Link>
            );
          })}
        </div>
      </div>

      {/* The selected day, in full. On a phone this is the month view's real
          content — the grid above is the picker — which is why it repeats what
          the desktop cells already show rather than being a desktop-only
          detail panel. */}
      <section aria-labelledby="calendar-agenda-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 id="calendar-agenda-heading" className="text-base font-semibold capitalize">
            {selectedLabel}
          </h3>
          {selectedEvents.length > 0 && (
            <span className="text-sm tabular-nums text-muted-foreground">
              {t("web.calendar.classCount", { count: selectedEvents.length })}
            </span>
          )}
        </div>
        {selectedEvents.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            {emptyDayText}
          </p>
        ) : (
          <AgendaList events={selectedEvents} statusLabel={statusLabel} t={t} />
        )}
      </section>

      <CalendarLegend statusLabel={statusLabel} t={t} />
    </div>
  );
}
