"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Clock } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { cn } from "@/lib/utils";
import { lessonClock } from "@/lib/video/lesson-clock";

// Often enough that the minute never reads stale for long, rarely enough to
// cost nothing.
const CLOCK_TICK_MS = 15_000;

// The call's top bar: the teacher's or student's notes on the left, who the
// call is with and how much of the class is left in the middle, the window
// controls on the right.
//
// A row of its own, above the stage rather than floating over it. Floating,
// the notes chip, the pop-out and minimise buttons and the status pills all
// sat on top of whatever filled the stage — and when that was a shared
// material, on top of its title and first lines, which a teacher reported she
// could not read while teaching from it. The stage now starts below the bar.
//
// On a phone the name drops out and only the clock stays, so the middle never
// runs into the notes chip.
export function CallTopBar({
  notes,
  otherName,
  startAt,
  endAt,
  indicators,
  controls,
}: {
  notes: ReactNode;
  // The other participant's display name, once they are in the room.
  otherName: string | null;
  startAt?: string;
  endAt?: string;
  // Small, ongoing states shown beside the clock (learning notes being kept).
  indicators?: ReactNode;
  controls: ReactNode;
}) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const start = startAt ? Date.parse(startAt) : NaN;
  const end = endAt ? Date.parse(endAt) : NaN;
  const clock =
    Number.isFinite(start) && Number.isFinite(end) ? lessonClock(now, start, end) : null;
  const clockLabel = clock
    ? t(
        clock.phase === "before"
          ? "call.clockStartsIn"
          : clock.phase === "during"
            ? "call.clockLeft"
            : "call.clockOver",
        { minutes: clock.minutes },
      )
    : null;

  return (
    <div className="relative z-40 flex h-14 shrink-0 items-center gap-2 px-3">
      {/* Notes: the card's own header is the chip; open, it hangs down over
      the stage, so the bar keeps its height whatever the notes do. */}
      <div className="relative h-9 min-w-0 flex-1">
        <div className="pointer-events-none absolute top-0 left-0 z-10 max-h-under-bar w-72 overflow-y-auto">
          {notes}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 text-sm" aria-live="off">
        {otherName && (
          <span className="hidden max-w-48 truncate font-medium text-white sm:inline">
            {otherName}
          </span>
        )}
        {clock && clockLabel && (
          <span
            data-testid="lesson-clock"
            data-warn={clock.warn || undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium tabular-nums",
              clock.warn ? "bg-warning text-warning-foreground" : "bg-overlay-1 text-on-dark-muted",
            )}
          >
            <Clock className="h-3.5 w-3.5" aria-hidden />
            {clockLabel}
          </span>
        )}
        {indicators}
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">{controls}</div>
    </div>
  );
}
