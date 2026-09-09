"use client";

import { useEffect, useState } from "react";
import { minutesOfDayInTz } from "@spiralclass/shared";

/**
 * Where "now" is on today's column.
 *
 * WHY THIS IS A CLIENT COMPONENT on an otherwise entirely server-rendered
 * calendar. The line was server-positioned from the request clock, which is
 * exact at first paint and wrong from then on — a teacher who leaves the tab
 * open through a morning is shown a red rule that says "you are here" and is
 * an hour out. A stale line is worse than no line, because nothing about it
 * looks stale; it is the only element on the page that asserts something about
 * the present moment.
 *
 * PROGRESSIVE ENHANCEMENT, not a client rewrite. The server still computes the
 * initial position and this renders it on the first paint, so the line is
 * correct with JavaScript disabled, correct before hydration, and never causes
 * a layout shift when hydration arrives. All the client adds is a minute tick
 * that keeps it correct afterwards.
 *
 * The recomputation runs in the SAME zone the page laid the grid out in — the
 * viewer's own — rather than the browser's. A teacher travelling, or working
 * from a machine whose clock is on another zone, must see her own schedule's
 * clock and not the laptop's.
 */
export function CurrentTimeLine({
  timeZone,
  initialMinutes,
  startHour,
  endHour,
  hourPx,
  label,
}: {
  timeZone: string;
  /** Minutes from local midnight at render time, resolved on the server. */
  initialMinutes: number;
  startHour: number;
  /** Exclusive. */
  endHour: number;
  hourPx: number;
  label: string;
}) {
  const [minutes, setMinutes] = useState(initialMinutes);

  useEffect(() => {
    const tick = () => setMinutes(minutesOfDayInTz(new Date(), timeZone));
    // Once immediately: a tab restored from the bfcache, or a page served from
    // a cache, can mount with an `initialMinutes` that is already old.
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [timeZone]);

  if (minutes < startHour * 60 || minutes >= endHour * 60) return null;
  const top = ((minutes - startHour * 60) / 60) * hourPx;

  return (
    <div
      role="img"
      aria-label={label}
      style={{ top }}
      className="absolute inset-x-0 z-20 h-0.5 bg-destructive"
    >
      <span className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-destructive" />
    </div>
  );
}
