"use client";

import { useCallback, useMemo, useState } from "react";
import { CalendarOff, Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { SettingRow, SettingsSection } from "@/components/ui/settings-section";
import { useLocale, useT } from "@/components/locale-provider";
import { isValidYmd, monthOf, ymdToUtcNoon } from "@/lib/calendar-grid";
import {
  countOverlapping,
  dayCounts,
  isFullyCovered,
  normalizeRange,
  rangeLength,
  type DayRange,
} from "@/lib/blocked-dates/ranges";
import { BlockedDatesCalendar, type BlockView } from "./blocked-dates-calendar";
import { BlockedDateForm } from "./blocked-date-form";
import { BlockedList } from "./blocked-list";
import { RemoveBlockButton } from "./remove-block-button";

/**
 * The blocked-dates screen, minus its page header.
 *
 * One client component owns the selection because three views share it: the
 * calendar you pick on, the date fields you type into, and the summary that
 * says what will happen when you press the button. The screen this replaced
 * had them as three unrelated cards, and only the last of them — after the
 * fact — mentioned that blocking cancels booked classes.
 *
 * Everything it needs arrives as calendar-date strings already resolved in the
 * teacher's zone by the server, so no timezone maths happens on the client and
 * the two cannot disagree about which day it is.
 */
export function BlockedDatesManager({
  tz,
  todayYmd,
  initialYear,
  initialMonth0,
  blocks,
  classSpans,
}: {
  tz: string;
  /** Today in the teacher's zone. */
  todayYmd: string;
  initialYear: number;
  initialMonth0: number;
  /** Every block from the start of the current month on — including one that
   * has already ended, so the grid does not show this month as free when it
   * was not. The list below is filtered to what is still ahead. */
  blocks: readonly BlockView[];
  /** One entry per scheduled class, as the calendar days it touches. A class
   * running past midnight spans two, which is exactly the set the server
   * cancels by interval overlap. */
  classSpans: readonly DayRange[];
}) {
  const t = useT();
  const locale = useLocale();

  const [month, setMonth] = useState({ year: initialYear, month0: initialMonth0 });
  const [range, setRange] = useState<DayRange>({ start: todayYmd, end: todayYmd });
  // The first day of a pick that has not been closed yet. While it is set, the
  // calendar previews where a second click would land.
  const [anchor, setAnchor] = useState<string | null>(null);
  const [highlightedBlockId, setHighlightedBlockId] = useState<string | null>(null);

  const classCounts = useMemo(() => dayCounts(classSpans), [classSpans]);
  const upcoming = useMemo(() => blocks.filter((b) => b.end >= todayYmd), [blocks, todayYmd]);

  const rangeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        timeZone: "UTC",
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    [locale],
  );
  const formatRange = useCallback(
    (r: { start: string; end: string }) =>
      r.start === r.end
        ? rangeFormat.format(ymdToUtcNoon(r.start))
        : t("web.settings.blockedDates.rangeLabel", {
            start: rangeFormat.format(ymdToUtcNoon(r.start)),
            end: rangeFormat.format(ymdToUtcNoon(r.end)),
          }),
    [rangeFormat, t],
  );

  const rangeIsReal = isValidYmd(range.start) && isValidYmd(range.end) && range.start <= range.end;
  const impactCount = rangeIsReal ? countOverlapping(classSpans, range) : 0;
  const alreadyBlocked = rangeIsReal && isFullyCovered(blocks, range);
  // The single existing block that swallows the whole selection, if there is
  // one — so "already blocked" can offer the way out instead of only saying no.
  const coveringBlock = rangeIsReal
    ? (blocks.find((b) => b.start <= range.start && b.end >= range.end) ?? null)
    : null;

  function pickDay(ymd: string) {
    if (anchor) {
      setRange(normalizeRange(anchor, ymd));
      setAnchor(null);
    } else {
      setRange({ start: ymd, end: ymd });
      setAnchor(ymd);
    }
  }

  function changeStart(value: string) {
    setAnchor(null);
    // Dragging the start past the end collapses the range onto the new start
    // rather than leaving an invalid pair on screen for the submit to reject.
    setRange((prev) => ({ start: value, end: value > prev.end ? value : prev.end }));
    if (isValidYmd(value)) setMonth(monthOf(value));
  }

  function changeEnd(value: string) {
    setAnchor(null);
    setRange((prev) => ({ start: prev.start, end: value }));
    if (isValidYmd(value)) setMonth(monthOf(value));
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        id="new-block"
        title={t("web.settings.blockedDates.planTitle")}
        description={t("web.settings.blockedDates.planBody", { tz })}
      >
        <SettingRow className="p-4 lg:p-6">
          <div className="grid gap-8 lg:grid-cols-2">
            <div className="space-y-3">
              <BlockedDatesCalendar
                year={month.year}
                month0={month.month0}
                todayYmd={todayYmd}
                blocks={blocks}
                classCounts={classCounts}
                selection={rangeIsReal ? range : null}
                anchor={anchor}
                highlightedBlockId={highlightedBlockId}
                onPickDay={pickDay}
                onMonthChange={(year, month0) => setMonth({ year, month0 })}
              />
              {anchor && (
                <p className="text-sm text-muted-foreground">
                  {t("web.settings.blockedDates.selectionOpen")}
                </p>
              )}
            </div>

            <div className="space-y-4">
              {/* The headline of the composer, and the screen's live region:
                  a pick made with the mouse is otherwise silent, and the date
                  fields below it are two values rather than one statement. */}
              <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-2">
                <p className="text-h3 font-semibold">{rangeIsReal ? formatRange(range) : "—"}</p>
                {rangeIsReal && (
                  <Badge variant="outline">
                    {t("web.settings.blockedDates.selectionDays", { count: rangeLength(range) })}
                  </Badge>
                )}
              </div>

              {alreadyBlocked && (
                // Not merely a refusal: when one existing block swallows the
                // whole selection, taking that block off is probably what the
                // teacher came here to do, so it is offered right here rather
                // than left to be found again in the list below.
                <Alert variant="info" className="flex flex-wrap items-center justify-between gap-2">
                  <AlertDescription>
                    <Info className="inline size-4 align-text-bottom" aria-hidden />{" "}
                    {t("web.settings.blockedDates.alreadyBlocked")}
                  </AlertDescription>
                  {coveringBlock && (
                    <RemoveBlockButton
                      blockId={coveringBlock.id}
                      range={formatRange(coveringBlock)}
                    />
                  )}
                </Alert>
              )}

              <BlockedDateForm
                startDate={range.start}
                endDate={range.end}
                minDate={todayYmd}
                impactCount={impactCount}
                onChangeStart={changeStart}
                onChangeEnd={changeEnd}
                onBlocked={() => {
                  setRange({ start: todayYmd, end: todayYmd });
                  setAnchor(null);
                }}
              />
            </div>
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        id="blocks"
        title={t("web.settings.blockedDates.listTitle")}
        description={
          upcoming.length > 0
            ? t("web.settings.blockedDates.listBody", { count: upcoming.length })
            : undefined
        }
      >
        {upcoming.length === 0 ? (
          <EmptyState
            icon={CalendarOff}
            title={t("web.settings.blockedDates.emptyTitle")}
            description={t("web.settings.blockedDates.emptyBody")}
            // Rendered as the section's own card body rather than inside a
            // SettingRow: the section already draws the card, and a second one
            // inside it is a box in a box with 88px of padding between them.
            className="border-0 bg-transparent shadow-none"
          />
        ) : (
          <BlockedList
            blocks={upcoming}
            todayYmd={todayYmd}
            formatRange={formatRange}
            onHighlight={setHighlightedBlockId}
            onShowOnCalendar={(block) => {
              setMonth(monthOf(block.start));
              // The grid is above the list and, on a phone, a long way above
              // it — jumping the month with nothing on screen to show for it
              // is the same as doing nothing.
              document.getElementById("new-block")?.scrollIntoView({
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                  ? "auto"
                  : "smooth",
                block: "start",
              });
            }}
          />
        )}
      </SettingsSection>
    </div>
  );
}
