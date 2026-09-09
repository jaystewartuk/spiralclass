// Pure layout math for Google-Calendar-style time-grid views (week + day),
// shared by the web and mobile apps so both position events identically.
//
// The grid is a vertical hour axis: an event's vertical position is its start
// time-of-day (minutes from local midnight) and its height is its duration.
// When events overlap they split the day's horizontal width into side-by-side
// columns. None of this is timezone- or platform-aware — callers convert an
// instant to "minutes from local midnight in the relevant zone" via
// `minutesOfDayInTz` and hand us plain numbers, so this module stays a
// deterministic, unit-testable function of integers.

/** Minutes from local midnight (0–1439) for an instant, in an IANA timezone. */
export function minutesOfDayInTz(instant: string | Date, timeZone: string): number {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  // Intl renders midnight as "24" in some engines; fold it back to 0.
  return ((hour % 24) * 60 + minute) % 1440;
}

export type TimedEvent = {
  id: string;
  /** Start, in minutes from local midnight (0–1439). */
  startMinutes: number;
  /** Duration in minutes; clamped to a small positive floor for layout. */
  durationMinutes: number;
};

export type LaidOutEvent<T extends TimedEvent> = T & {
  /** Effective start/end in minutes after clamping (end = start + max(dur, MIN)). */
  layoutStart: number;
  layoutEnd: number;
  /** Zero-based column index within this event's overlap cluster. */
  column: number;
  /** Total columns the cluster was split into (≥ 1). */
  columns: number;
};

// A 0-minute booking still needs a tappable sliver; give it a floor so it lays
// out (and later renders) with a real height. 5 min is below any real lesson.
const MIN_LAYOUT_MINUTES = 5;

/**
 * Assign each event a column so overlapping events sit side by side.
 * Returns events sorted by start; each annotated with column / columns and the
 * clamped layout interval. Two events that merely touch (one ends exactly when
 * the next starts) do NOT overlap and reuse the same column.
 */
export function layoutOverlaps<T extends TimedEvent>(events: T[]): LaidOutEvent<T>[] {
  const sorted = [...events]
    .map((e) => {
      const layoutStart = e.startMinutes;
      const layoutEnd = e.startMinutes + Math.max(e.durationMinutes, MIN_LAYOUT_MINUTES);
      return { ...e, layoutStart, layoutEnd, column: 0, columns: 1 } as LaidOutEvent<T>;
    })
    .sort((a, b) => a.layoutStart - b.layoutStart || a.layoutEnd - b.layoutEnd);

  let cluster: LaidOutEvent<T>[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    const cols = Math.max(1, ...cluster.map((e) => e.column + 1));
    for (const e of cluster) e.columns = cols;
    cluster = [];
  };

  // `colEnds[i]` = the layoutEnd of the last event placed in column i.
  let colEnds: number[] = [];

  for (const e of sorted) {
    if (e.layoutStart >= clusterEnd && cluster.length > 0) {
      flush();
      colEnds = [];
    }
    // First free column (its last event ends at or before this one's start).
    let col = colEnds.findIndex((end) => end <= e.layoutStart);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(e.layoutEnd);
    } else {
      colEnds[col] = e.layoutEnd;
    }
    e.column = col;
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.layoutEnd);
  }
  if (cluster.length > 0) flush();

  return sorted;
}

export type HourRange = { startHour: number; endHour: number };

/**
 * The whole-hour window [startHour, endHour) the grid should render. Defaults to
 * a business-day window and expands outward to contain every event, clamped to
 * [0, 24]. `endHour` is exclusive and always > `startHour`.
 */
export function visibleHourRange(
  events: Pick<TimedEvent, "startMinutes" | "durationMinutes">[],
  opts: { defaultStartHour?: number; defaultEndHour?: number } = {},
): HourRange {
  const defaultStartHour = opts.defaultStartHour ?? 7;
  const defaultEndHour = opts.defaultEndHour ?? 21;

  let startHour = defaultStartHour;
  let endHour = defaultEndHour;

  for (const e of events) {
    const start = e.startMinutes;
    const end = e.startMinutes + Math.max(e.durationMinutes, MIN_LAYOUT_MINUTES);
    startHour = Math.min(startHour, Math.floor(start / 60));
    // Round the end up to the next whole hour so the last event isn't clipped.
    endHour = Math.max(endHour, Math.ceil(end / 60));
  }

  startHour = Math.max(0, startHour);
  endHour = Math.min(24, endHour);
  if (endHour <= startHour) endHour = Math.min(24, startHour + 1);
  return { startHour, endHour };
}
