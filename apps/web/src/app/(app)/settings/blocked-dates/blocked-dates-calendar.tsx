"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale, useT } from "@/components/locale-provider";
import {
  buildMonthGrid,
  firstOfMonth,
  monthOf,
  shiftDay,
  shiftMonth,
  ymdToUtcNoon,
} from "@/lib/calendar-grid";
import { coversDay, rangeCovering, type DayRange } from "@/lib/blocked-dates/ranges";
import { cn } from "@/lib/utils";

export type BlockView = DayRange & { id: string; reason: string | null };

/**
 * The month grid the teacher PICKS a range on.
 *
 * The screen it replaced rendered a read-only grid above a pair of date
 * inputs: you looked at the calendar, then typed the day you had just looked
 * at, twice. Here the calendar is the control — one tap opens a range, a
 * second closes it — and the inputs stay beside it as the typed path, bound to
 * the same state.
 *
 * ACCESSIBILITY. This is the ARIA date-picker pattern rather than a grid of
 * divs: a real `<table role="grid">`, one tab stop for the whole month (roving
 * tabindex), arrows to move by day and week, PageUp/PageDown by month, Home
 * and End to the ends of the week. Each cell's accessible name is the full
 * localized date plus its state, because the column and month headings a
 * sighted reader gets for free are not in the tab order — the old cells
 * announced as a bare run of numbers, and the spill-over days at either end
 * belong to a month nobody was told about.
 *
 * Colour is never the only signal: a blocked day is struck through as well as
 * tinted, which is also what keeps it legible once selection recolours it.
 */
export function BlockedDatesCalendar({
  year,
  month0,
  todayYmd,
  blocks,
  classCounts,
  selection,
  anchor,
  highlightedBlockId,
  onPickDay,
  onMonthChange,
}: {
  year: number;
  month0: number;
  /** Today in the teacher's zone — the floor under what can be blocked. */
  todayYmd: string;
  blocks: readonly BlockView[];
  /** Scheduled classes per day, so a day is never blocked blind. */
  classCounts: ReadonlyMap<string, number>;
  selection: DayRange | null;
  /** The first day of an in-progress pick, or null when the range is closed. */
  anchor: string | null;
  highlightedBlockId: string | null;
  onPickDay: (ymd: string) => void;
  onMonthChange: (year: number, month0: number) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const gridRef = useRef<HTMLTableElement>(null);
  const [focusedYmd, setFocusedYmd] = useState<string>(() => selection?.start ?? todayYmd);
  const [hoveredYmd, setHoveredYmd] = useState<string | null>(null);
  const wantsFocus = useRef(false);

  const gridDays = useMemo(() => buildMonthGrid(year, month0), [year, month0]);

  const formatters = useMemo(
    () => ({
      month: new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", year: "numeric" }),
      weekdayShort: new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }),
      weekdayLong: new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long" }),
      day: new Intl.DateTimeFormat(locale, {
        timeZone: "UTC",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    }),
    [locale],
  );

  const monthLabel = formatters.month.format(ymdToUtcNoon(firstOfMonth(year, month0)));
  // 2024-01-01 was a Monday, and buildMonthGrid is Monday-start in every
  // locale — so these seven dates label the seven columns whatever the
  // reader's language. The headers used to be two hardcoded arrays picked by
  // `locale === "en"`, which handed a French teacher Spanish weekdays.
  const weekdays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = ymdToUtcNoon(`2024-01-0${i + 1}`);
        return { short: formatters.weekdayShort.format(d), long: formatters.weekdayLong.format(d) };
      }),
    [formatters],
  );

  // The one cell in the tab order. Derived rather than stored, so a month
  // change from the chevrons (which cannot know where the keyboard was) always
  // leaves exactly one tabbable cell instead of none.
  const inGrid = gridDays.some((d) => d.ymd === focusedYmd);
  const monthPrefix = firstOfMonth(year, month0).slice(0, 7);
  const tabbableYmd = inGrid
    ? focusedYmd
    : todayYmd.startsWith(monthPrefix)
      ? todayYmd
      : firstOfMonth(year, month0);

  useEffect(() => {
    if (!wantsFocus.current) return;
    wantsFocus.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-ymd="${focusedYmd}"]`)?.focus();
  }, [focusedYmd, year, month0]);

  function moveFocusTo(ymd: string) {
    wantsFocus.current = true;
    setFocusedYmd(ymd);
    const { year: y, month0: m } = monthOf(ymd);
    if (y !== year || m !== month0) onMonthChange(y, m);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, ymd: string) {
    const jump: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (e.key in jump) {
      e.preventDefault();
      moveFocusTo(shiftDay(ymd, jump[e.key]));
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      // Monday-start weeks, matching the grid.
      const dow = (ymdToUtcNoon(ymd).getUTCDay() + 6) % 7;
      moveFocusTo(shiftDay(ymd, e.key === "Home" ? -dow : 6 - dow));
      return;
    }
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      const next = shiftMonth(year, month0, e.key === "PageUp" ? -1 : 1);
      const dayOfMonth = ymd.slice(-2);
      const candidate = `${firstOfMonth(next.year, next.month0).slice(0, 7)}-${dayOfMonth}`;
      // A month short of that day (31 January → February) falls back to its
      // first, which is where the grid opens anyway.
      const target = buildMonthGrid(next.year, next.month0).some((d) => d.ymd === candidate)
        ? candidate
        : firstOfMonth(next.year, next.month0);
      moveFocusTo(target);
    }
  }

  // While a range is open, the day under the pointer previews where it would
  // close — the difference between "pick two dates" and seeing the week fill in.
  const preview: DayRange | null =
    anchor && hoveredYmd && hoveredYmd >= todayYmd
      ? anchor <= hoveredYmd
        ? { start: anchor, end: hoveredYmd }
        : { start: hoveredYmd, end: anchor }
      : selection;

  const goToMonth = (delta: number) => {
    const next = shiftMonth(year, month0, delta);
    onMonthChange(next.year, next.month0);
  };
  const showTodayButton = !todayYmd.startsWith(monthPrefix);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold capitalize" aria-live="polite">
          {monthLabel}
        </h3>
        <div className="flex items-center gap-1">
          {showTodayButton && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const today = monthOf(todayYmd);
                onMonthChange(today.year, today.month0);
              }}
            >
              <CalendarDays className="h-4 w-4" aria-hidden />
              {t("web.settings.blockedDates.today")}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("web.settings.blockedDates.prevMonth")}
            onClick={() => goToMonth(-1)}
          >
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("web.settings.blockedDates.nextMonth")}
            onClick={() => goToMonth(1)}
          >
            <ChevronRight className="h-5 w-5" aria-hidden />
          </Button>
        </div>
      </div>

      <table
        ref={gridRef}
        role="grid"
        aria-label={`${t("web.settings.blockedDates.calendarLabel")}, ${monthLabel}`}
        className="w-full table-fixed border-separate border-spacing-1"
        onMouseLeave={() => setHoveredYmd(null)}
      >
        <thead>
          <tr>
            {weekdays.map((w) => (
              <th
                key={w.long}
                scope="col"
                className="text-muted-foreground pb-1 text-xs font-medium"
              >
                <span aria-hidden className="capitalize">
                  {w.short}
                </span>
                <span className="sr-only">{w.long}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: gridDays.length / 7 }, (_, week) => (
            <tr key={week}>
              {gridDays.slice(week * 7, week * 7 + 7).map((day) => {
                const block = rangeCovering(blocks, day.ymd);
                const isBlocked = Boolean(block);
                const isHighlighted = Boolean(block && block.id === highlightedBlockId);
                const isPast = day.ymd < todayYmd;
                const isToday = day.ymd === todayYmd;
                const isPicked = Boolean(preview && coversDay(preview, day.ymd));
                const classCount = classCounts.get(day.ymd) ?? 0;

                const stateWords = [
                  isToday ? t("web.settings.blockedDates.today") : null,
                  isBlocked ? t("web.settings.blockedDates.blocked") : null,
                  isPast ? t("web.settings.blockedDates.dayPast") : null,
                  isPicked ? t("web.settings.blockedDates.selected") : null,
                  classCount > 0
                    ? t("web.settings.blockedDates.dayClasses", { count: classCount })
                    : null,
                ].filter(Boolean);

                return (
                  <td key={day.ymd} role="gridcell" aria-selected={isPicked} className="p-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      data-ymd={day.ymd}
                      tabIndex={day.ymd === tabbableYmd ? 0 : -1}
                      aria-disabled={isPast || undefined}
                      aria-current={isToday ? "date" : undefined}
                      aria-label={[
                        formatters.day.format(ymdToUtcNoon(day.ymd)),
                        ...stateWords,
                      ].join(", ")}
                      onKeyDown={(e) => handleKeyDown(e, day.ymd)}
                      onFocus={() => setFocusedYmd(day.ymd)}
                      onMouseEnter={() => setHoveredYmd(day.ymd)}
                      onClick={() => {
                        if (isPast) return;
                        onPickDay(day.ymd);
                      }}
                      className={cn(
                        "relative w-full flex-col gap-0 rounded-md font-normal lg:w-full",
                        !day.inCurrentMonth && "opacity-45",
                        isPast && "text-muted-foreground cursor-not-allowed hover:bg-transparent",
                        isBlocked && !isPicked && "bg-destructive-bg text-destructive font-medium",
                        isHighlighted && !isPicked && "ring-destructive ring-2",
                        isPicked &&
                          "bg-primary text-primary-foreground hover:bg-primary-hover hover:text-primary-foreground font-semibold",
                        isToday && !isPicked && !isBlocked && "ring-primary ring-1",
                      )}
                    >
                      <span className={cn(isBlocked && "line-through")}>
                        {Number(day.ymd.slice(-2))}
                      </span>
                      {classCount > 0 && (
                        <span
                          aria-hidden
                          className={cn(
                            "absolute bottom-1 h-1 w-1 rounded-full",
                            isPicked ? "bg-primary-foreground" : "bg-info",
                          )}
                        />
                      )}
                    </Button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="bg-primary h-3 w-3 rounded-sm" />
          {t("web.settings.blockedDates.selected")}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="bg-destructive-bg h-3 w-3 rounded-sm" />
          {t("web.settings.blockedDates.blocked")}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="bg-info h-1.5 w-1.5 rounded-full" />
          {t("web.settings.blockedDates.legendClasses")}
        </li>
      </ul>
    </div>
  );
}
