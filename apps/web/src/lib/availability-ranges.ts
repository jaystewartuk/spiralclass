// Grouping/merge helpers for the day-pill availability editor. The web wire
// format is a flat list of {weekday, startTime, endTime} rows (times as "HH:MM"
// strings), so a day's ranges are just every row matching that weekday. Pulled
// out of the form component so the logic is unit-testable without a React
// render harness.

export type AvailabilityRange = {
  weekday: number;
  startTime: string;
  endTime: string;
};

// The <input type="time"> step is whole minutes, so 23:59 is the latest
// possible end time — used to know when a day is "full" and can't take
// another range.
export const DAY_END_MINUTES = 23 * 60 + 59;

export function timeToMinutes(time: string): number {
  const [h, m] = time.split(":");
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}

export function minutesToTime(total: number): string {
  const clamped = Math.max(0, Math.min(DAY_END_MINUTES, total));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function rangesForDay(ranges: AvailabilityRange[], weekday: number): AvailabilityRange[] {
  return (
    ranges
      .filter((r) => r.weekday === weekday)
      // "HH:MM" is zero-padded, so a lexical sort is chronological.
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
  );
}

export function replaceDayRanges(
  ranges: AvailabilityRange[],
  weekday: number,
  nextRanges: AvailabilityRange[],
): AvailabilityRange[] {
  return [...ranges.filter((r) => r.weekday !== weekday), ...nextRanges];
}

// Where a freshly-added range should start/end: right after the day's last
// range, or a default mid-morning slot if the day has none yet. Returns null
// when the day is already booked solid and can't fit another range.
export function nextRangeDefaults(
  ranges: AvailabilityRange[],
): { startTime: string; endTime: string } | null {
  const last = ranges[ranges.length - 1];
  const start = last ? timeToMinutes(last.endTime) : 10 * 60;
  const end = Math.min(start + 60, DAY_END_MINUTES);
  if (end <= start) return null;
  return { startTime: minutesToTime(start), endTime: minutesToTime(end) };
}
