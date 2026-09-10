import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { TFunction } from "@/lib/i18n-translate";
import { cn } from "@/lib/utils";
import type { CalendarEvent } from "./event";
import { styleFor } from "./status-style";

/**
 * A day's classes, one row each — the month view's selected-day panel and the
 * day view's main content.
 *
 * The status used to sit at the far right edge of the row, which at 1280px put
 * it a thousand pixels from the name it describes: two independent columns to
 * read rather than one line, and a wide band of nothing in between. Everything
 * now sits in one left-aligned block that stays legible at any width, with the
 * duration on the right where a scanning eye can compare it down the column.
 */
export function AgendaList({
  events,
  statusLabel,
  t,
}: {
  events: CalendarEvent[];
  statusLabel: (status: string) => string;
  t: TFunction;
}) {
  return (
    <ul className="bg-card shadow-brand-sm divide-y overflow-hidden rounded-lg border">
      {events.map((e) => {
        const style = styleFor(e.status);
        return (
          <li key={e.id}>
            <Link
              href={e.href}
              className="group hover:bg-muted/50 flex items-center gap-3 px-3 py-3 transition-colors sm:gap-4 sm:px-4"
            >
              <span aria-hidden className={cn("h-10 w-1 shrink-0 rounded-full", style.dot)} />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold tabular-nums">{e.timeLabel}</span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-sm font-medium",
                      style.chip,
                      // The routine case does not need a label — a blue dot and
                      // a future date already say "scheduled". Labelling only
                      // the exceptions is what makes an exception visible.
                      e.status === "scheduled" && "sr-only",
                    )}
                  >
                    {statusLabel(e.status)}
                  </span>
                </div>
                <div className="truncate">{e.title}</div>
              </div>
              <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
                {t("web.dashboard.home.schedule.durationMin", { count: e.durationMinutes })}
              </span>
              <ChevronRight
                aria-hidden
                className="text-muted-foreground group-hover:text-foreground h-4 w-4 shrink-0 transition-colors"
              />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
