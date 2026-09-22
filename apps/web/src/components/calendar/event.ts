// What the calendar views agree a class looks like.
//
// This lived in calendar-month.tsx, which meant the week view, the day view,
// the time grid and both pages all imported their core type — and the shared
// `groupByDay` — from a file named after one of the three views. The day view
// pulling `AgendaList` and `groupByDay` out of "calendar-month" was the point
// it stopped reading as an accident and started reading as a mistake.

/** A single class on the calendar. Day bucketing and label formatting happen
 * in the page (which holds the timezone and locale); every component below is
 * purely presentational and timezone-agnostic. */
export type CalendarEvent = {
  id: string;
  /** `YYYY-MM-DD` in the display timezone — which cell this lands in. */
  ymd: string;
  href: string;
  /** Sort key within a day. */
  startUtc: Date;
  /** Minutes from local midnight in the display timezone — the time-grid's
   * vertical position. */
  startMinutes: number;
  /** Class length in minutes — the time-grid block's height. */
  durationMinutes: number;
  /** e.g. "09:00" (already localised, may carry a second zone). */
  timeLabel: string;
  /** Student name (teacher view) or teacher name (student view). */
  title: string;
  status: string;
};

/** Bucket events by day, sorted within a day by start. */
export function groupByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const byDay = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const list = byDay.get(e.ymd) ?? [];
    list.push(e);
    byDay.set(e.ymd, list);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
  }
  return byDay;
}
