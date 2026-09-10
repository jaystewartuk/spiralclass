import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AppLocale } from "@/lib/i18n";
import { getT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { buildMonthGrid, firstOfMonth, ymdToUtcNoon } from "@/lib/calendar-grid";
import { HardLink } from "./hard-link";

// A compact month grid for the booking flow. Unlike the read-only
// CalendarMonth (which renders existing classes), every cell here reflects
// *availability*: days with at least one open slot are tappable and dotted;
// days with none — or outside the booking window — are dimmed and inert. The
// selected day's slots render below the calendar in the page. Fully
// server-rendered (no client JS); navigation is plain links.
export async function BookingMonthCalendar({
  year,
  month0,
  selectedYmd,
  todayYmd,
  minYmd,
  maxYmd,
  availableDays,
  locale,
  dayHref,
  prevHref,
  nextHref,
}: {
  year: number;
  month0: number;
  selectedYmd: string;
  todayYmd: string;
  /** Earliest bookable day (inclusive), `YYYY-MM-DD`. */
  minYmd: string;
  /** Latest bookable day (inclusive), `YYYY-MM-DD`. */
  maxYmd: string;
  availableDays: Set<string>;
  locale: AppLocale;
  dayHref: (ymd: string) => string;
  /** Null disables the chevron (no bookable days that direction). */
  prevHref: string | null;
  nextHref: string | null;
}) {
  const t = await getT();
  const grid = buildMonthGrid(year, month0);

  const monthLabel = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(ymdToUtcNoon(firstOfMonth(year, month0)));

  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(
      ymdToUtcNoon(`2024-01-0${i + 1}`),
    ),
  );

  // The accessible name of a day cell. It used to be the bare day NUMBER plus
  // "available" — "12 — available" — which is what a sighted reader gets from
  // the grid's own column and month headings and a screen-reader user does
  // not: tabbing the grid gave a run of numbers with no weekday and no month,
  // and the spill-over cells at either end silently belong to a different one.
  // One formatter, reused across the 42 cells rather than built per cell.
  const dayName = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold capitalize">{monthLabel}</h3>
        <div className="flex items-center gap-1">
          <ChevronNav href={prevHref} label={t("web.calendar.previousMonth")} dir="prev" />
          <ChevronNav href={nextHref} label={t("web.calendar.nextMonth")} dir="next" />
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-muted-foreground">
        {weekdays.map((w, i) => (
          <div key={i} className="py-1 capitalize">
            {w}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {grid.map((g) => {
          const dayNum = Number(g.ymd.slice(-2));
          const inRange = g.ymd >= minYmd && g.ymd <= maxYmd;
          const available = inRange && availableDays.has(g.ymd);
          const isSelected = g.ymd === selectedYmd;
          const isToday = g.ymd === todayYmd;

          const base =
            "relative flex h-10 flex-col items-center justify-center rounded-md text-sm transition-colors";

          if (available) {
            return (
              <HardLink
                key={g.ymd}
                href={dayHref(g.ymd)}
                // A stable hook for the browser suites. The accessible name is
                // the localized date, which is presentation and has already
                // changed once (it was the bare day number until #1006) —
                // selecting on it coupled three e2e journeys to a copy string
                // and broke all three the day it improved.
                data-testid="calendar-day-available"
                aria-current={isSelected ? "date" : undefined}
                aria-label={`${dayName.format(ymdToUtcNoon(g.ymd))} — ${t(
                  "web.calendar.availableSuffix",
                )}`}
                className={cn(
                  base,
                  isSelected
                    ? "bg-primary font-semibold text-primary-foreground"
                    : "text-foreground hover:bg-primary/10",
                  !g.inCurrentMonth && !isSelected && "text-muted-foreground",
                )}
              >
                {dayNum}
                {!isSelected && (
                  <span className="absolute bottom-1 h-1 w-1 rounded-full bg-primary" />
                )}
              </HardLink>
            );
          }

          // Inert cell: no availability, or outside the booking window.
          return (
            <div
              key={g.ymd}
              aria-disabled="true"
              className={cn(
                base,
                "text-muted-foreground/40",
                isToday && "ring-1 ring-border ring-inset",
              )}
            >
              {dayNum}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          {t("web.calendar.available")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm bg-primary" />
          {t("web.calendar.selected")}
        </span>
      </div>
    </div>
  );
}

function ChevronNav({
  href,
  label,
  dir,
}: {
  href: string | null;
  label: string;
  dir: "prev" | "next";
}) {
  const Icon = dir === "prev" ? ChevronLeft : ChevronRight;
  if (!href) {
    return (
      <span
        aria-hidden
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground/30"
      >
        <Icon className="h-5 w-5" />
      </span>
    );
  }
  return (
    <HardLink
      href={href}
      aria-label={label}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      <Icon className="h-5 w-5" />
    </HardLink>
  );
}
