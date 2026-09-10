"use client";

import { CalendarSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";
import { rangeLength } from "@/lib/blocked-dates/ranges";
import type { BlockView } from "./blocked-dates-calendar";
import { RemoveBlockButton } from "./remove-block-button";

/**
 * The blocks already in place.
 *
 * Each row answers the three questions the old flat list did not: WHEN
 * relative to now (on already, tomorrow, in nine days), HOW LONG it runs, and
 * WHERE it is on the calendar. Hovering or focusing a row rings its days in
 * the grid above, which is the only way a block spanning two months reads as
 * one thing rather than as two.
 */
export function BlockedList({
  blocks,
  todayYmd,
  formatRange,
  onHighlight,
  onShowOnCalendar,
}: {
  blocks: readonly BlockView[];
  todayYmd: string;
  formatRange: (range: { start: string; end: string }) => string;
  onHighlight: (id: string | null) => void;
  onShowOnCalendar: (block: BlockView) => void;
}) {
  const t = useT();

  return (
    <ul className="divide-y divide-border">
      {blocks.map((block) => {
        const range = formatRange(block);
        const running = block.start <= todayYmd;
        return (
          <li
            key={block.id}
            className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-6 py-4"
            onMouseEnter={() => onHighlight(block.id)}
            onMouseLeave={() => onHighlight(null)}
            onFocus={() => onHighlight(block.id)}
            onBlur={() => onHighlight(null)}
          >
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{range}</span>
                <Badge variant={running ? "destructive" : "secondary"}>
                  {running
                    ? t("web.settings.blockedDates.onNow")
                    : t("web.settings.blockedDates.startsIn", {
                        count: rangeLength({ start: todayYmd, end: block.start }) - 1,
                      })}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {t("web.settings.blockedDates.dayCount", { count: rangeLength(block) })}
                {block.reason ? ` · ${block.reason}` : ""}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("web.settings.blockedDates.showOnCalendar", { range })}
                onClick={() => onShowOnCalendar(block)}
              >
                <CalendarSearch className="size-4" aria-hidden />
              </Button>
              <RemoveBlockButton blockId={block.id} range={range} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
