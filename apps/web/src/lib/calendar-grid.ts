// Pure calendar-grid math for the month view (Phase 1 calendar). Everything
// here operates on plain `YYYY-MM-DD` date strings and UTC arithmetic so it is
// deterministic and DST-proof — these are *calendar dates*, not instants, so
// no timezone is involved. The timezone-aware part (which day a booking lands
// on) is done by the caller with `toYMD(start, tz)` from `@/lib/tz`.
//
// Weeks start on Monday, matching the es-MX launch market.

export type GridDay = {
  /** `YYYY-MM-DD` */
  ymd: string;
  /** Whether this cell belongs to the month being rendered (vs. spill-over). */
  inCurrentMonth: boolean;
  /** `YYYY-MM` of this cell — used so clicking a spill-over day navigates months. */
  monthStr: string;
};

/** A `Date` pinned to noon UTC for a calendar date — safe for label formatting. */
export function ymdToUtcNoon(ymd: string): Date {
  return new Date(`${ymd}T12:00:00.000Z`);
}

/**
 * Whether `ymd` is a real calendar date, not just format-valid. The `?d=` URL
 * param is validated with only a `\d{4}-\d{2}-\d{2}` regex by the calendar
 * pages, which accepts calendar-impossible strings ("2026-13-45", "2026-02-30").
 * Those produce an Invalid Date (or a silently rolled-over one) here, and the
 * downstream getUTCDay/utcYmd math yields NaN — crashing the day/week views
 * with a 500. Round-trip the parsed date to reject anything that isn't a
 * genuine calendar day.
 */
export function isValidYmd(ymd: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const d = new Date(`${ymd}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return false;
  return utcYmd(d) === ymd;
}

function utcYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** `YYYY-MM` for a (year, 0-based month). */
export function monthStr(year: number, month0: number): string {
  return `${year}-${String(month0 + 1).padStart(2, "0")}`;
}

export function monthOf(ymd: string): { year: number; month0: number } {
  const [y, mo] = ymd.split("-").map(Number);
  return { year: y, month0: mo - 1 };
}

export function firstOfMonth(year: number, month0: number): string {
  return `${monthStr(year, month0)}-01`;
}

/** Parse a `?m=YYYY-MM` param, or null if absent/malformed. */
export function parseMonthParam(m: string | undefined): { year: number; month0: number } | null {
  if (m && /^\d{4}-\d{2}$/.test(m)) {
    const [y, mo] = m.split("-").map(Number);
    if (mo >= 1 && mo <= 12) return { year: y, month0: mo - 1 };
  }
  return null;
}

/** Shift a (year, 0-based month) by `delta` months, normalising the year. */
export function shiftMonth(
  year: number,
  month0: number,
  delta: number,
): { year: number; month0: number } {
  const d = new Date(Date.UTC(year, month0 + delta, 1, 12));
  return { year: d.getUTCFullYear(), month0: d.getUTCMonth() };
}

/**
 * Build the 6×7 (42-cell) Monday-start grid for a month, including the
 * leading/trailing spill-over days that fill the first and last weeks.
 *
 * `trimTrailingSpill` drops a final week that belongs entirely to the NEXT
 * month, leaving 35 cells. At most one week can ever qualify — the widest a
 * month can be is a 6-day leading offset plus 31 days, which is 37 cells and
 * therefore reaches into the sixth week — so this never removes a row that
 * holds a real date. It is off by default because the two BOOKING calendars
 * want a constant-height grid (their cells are tap targets in a form, and a
 * grid that changes height as you page months moves the button under the
 * cursor); the class calendar wants the opposite, because an all-spill row
 * there is two rows of nothing between the month and the agenda beneath it.
 */
export function buildMonthGrid(
  year: number,
  month0: number,
  opts: { trimTrailingSpill?: boolean } = {},
): GridDay[] {
  const first = new Date(Date.UTC(year, month0, 1, 12));
  const offset = (first.getUTCDay() + 6) % 7; // days since Monday
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - offset);

  const days: GridDay[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    days.push({
      ymd: utcYmd(d),
      inCurrentMonth: d.getUTCMonth() === month0,
      monthStr: monthStr(d.getUTCFullYear(), d.getUTCMonth()),
    });
  }
  if (opts.trimTrailingSpill && days.slice(35).every((d) => !d.inCurrentMonth)) {
    return days.slice(0, 35);
  }
  return days;
}

/**
 * The month grid the CLASS calendar renders — trailing all-spill week trimmed.
 *
 * It exists as a named function rather than an option passed at three call
 * sites because the page and the component have to agree on the cell set
 * exactly: the page derives `gridDays` from it to resolve `?d=`, and a day
 * resolved against 42 cells but rendered into 35 would select a cell that is
 * not on screen. One name is one answer.
 */
export function buildClassMonthGrid(year: number, month0: number): GridDay[] {
  return buildMonthGrid(year, month0, { trimTrailingSpill: true });
}

/**
 * Return the Monday (ISO week start) that contains `ymd`.
 * Works on calendar dates — no timezone needed.
 */
export function weekStartOf(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00.000Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0=Mon … 6=Sun
  d.setUTCDate(d.getUTCDate() - dow);
  return utcYmd(d);
}

/**
 * Build the 7 calendar dates for the week that contains `ymd` (Monday-start).
 */
export function buildWeekDays(ymd: string): GridDay[] {
  const monday = weekStartOf(ymd);
  const start = new Date(`${monday}T12:00:00.000Z`);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const cellYmd = utcYmd(d);
    return {
      ymd: cellYmd,
      inCurrentMonth: true,
      monthStr: monthStr(d.getUTCFullYear(), d.getUTCMonth()),
    };
  });
}

/** Shift `ymd` by `delta` days. */
export function shiftDay(ymd: string, delta: number): string {
  const d = new Date(`${ymd}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return utcYmd(d);
}

/**
 * Pick which day the agenda panel shows: an explicit `?d=` if it sits in the
 * visible grid, else today when it falls in the rendered month, else the 1st.
 */
export function resolveSelectedDay(opts: {
  requested?: string;
  gridDays: Set<string>;
  todayYmd: string;
  year: number;
  month0: number;
}): string {
  const { requested, gridDays, todayYmd, year, month0 } = opts;
  if (requested && isValidYmd(requested) && gridDays.has(requested)) {
    return requested;
  }
  if (todayYmd.startsWith(monthStr(year, month0)) && gridDays.has(todayYmd)) {
    return todayYmd;
  }
  return firstOfMonth(year, month0);
}
