import { toYMD, zonedWallClockToUtc } from "@/lib/tz";

// Small date helpers. Kept dependency-free (no date-fns) — we only need
// calendar-month arithmetic for package expiry.

// Package expiry anchored to end-of-day in the TEACHER'S timezone. Takes the
// teacher-local calendar date of `date`, adds `months` calendar months (clamping
// short target months, e.g. Jan 31 + 1mo → Feb 28/29), and lands on 23:59 local
// that day. Keeps expiry on the teacher's wall-clock calendar rather than UTC,
// so a package bought late at night in a tz far from UTC doesn't expire a day
// "early" — and matches how the extend-expiration override computes dates.
export function addMonthsEndOfDayInZone(date: Date, months: number, tz: string): Date {
  const [y, m, d] = toYMD(date, tz).split("-").map(Number);
  const firstOfTarget = new Date(Date.UTC(y, m - 1 + months, 1));
  const targetYear = firstOfTarget.getUTCFullYear();
  const targetMonth = firstOfTarget.getUTCMonth(); // 0-based
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  const ymd = `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return zonedWallClockToUtc(ymd, "23:59", tz);
}

// Add `months` calendar months to `date`, in UTC. Unlike the previous
// `months * 30 days` approximation (which expired a 12-month package ~5
// days early), this lands on the same day-of-month N months out. When the
// target month is shorter than the source day-of-month (e.g. Jan 31 + 1
// month), it clamps to the last day of the target month rather than
// overflowing into the next month.
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) {
    // Overflowed into the following month — back up to the last day of the
    // intended month.
    d.setUTCDate(0);
  }
  return d;
}
