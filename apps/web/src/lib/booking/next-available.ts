// Helpers for landing a student on a bookable day. The student booking page
// opens on "today"; when today has no openings we scan forward for the next
// day that does, so she sees times immediately instead of an empty state.
// Pure string/date math — no timezone or DB concerns — so it's cheap to reuse
// per-day and easy to test.

/** Add n days to a YYYY-MM-DD calendar date, returning YYYY-MM-DD. */
export function addCalendarDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * The first calendar day, scanning forward from `fromYmd` through `throughYmd`
 * inclusive, for which `hasSlots(ymd)` is true — or null if none in the window.
 * ISO YYYY-MM-DD strings order lexicographically, so the `<=` bound is a plain
 * string compare.
 */
export function firstAvailableDay(
  fromYmd: string,
  throughYmd: string,
  hasSlots: (ymd: string) => boolean,
): string | null {
  for (let day = fromYmd; day <= throughYmd; day = addCalendarDays(day, 1)) {
    if (hasSlots(day)) return day;
  }
  return null;
}
