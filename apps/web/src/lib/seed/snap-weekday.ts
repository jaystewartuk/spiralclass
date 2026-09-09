// Slice 7b — pure helper used by scripts/seed.ts to land seeded bookings
// on weekdays the teacher actually has availability for. The seed script
// previously did `addDays(now, N)` which, depending on when the seed
// runs, drops bookings on Sat/Sun outside Alicia Moreno's Mon–Fri rules.
// Harmless data-shape-wise (existing bookings don't have to match
// current availability) but confusing when demoing.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Returns the earliest Date >= `start` whose UTC weekday is in
 * `allowedWeekdays`. If `start` already matches, returns it unchanged.
 *
 * `allowedWeekdays` uses the same numbering as `Date.getUTCDay()`:
 *   0 = Sunday, 1 = Monday, ..., 6 = Saturday.
 *
 * Throws when no day in the next 7 matches (i.e. `allowedWeekdays` is
 * empty or invalid). Walks at most 7 days; this is a seed helper, not
 * a calendar engine.
 *
 * Note: weekday is read in UTC, not in any IANA tz. The seed script
 * computes UTC instants from `fromZonedTime("HH:00", teacherTz)` after
 * snapping, so a UTC-Saturday early-morning instant can map to a
 * still-Friday wall clock in the teacher's tz. For Alicia Moreno's
 * America/Mexico_City (UTC−6/−5) availability the offset is small
 * enough that snapping in UTC produces the expected visible weekday;
 * if a future teacher in UTC+12 ever needs this, swap the comparison
 * to a tz-aware getDay() via Intl.DateTimeFormat.
 */
export function nextWeekdayMatching(start: Date, allowedWeekdays: ReadonlyArray<number>): Date {
  if (allowedWeekdays.length === 0) {
    throw new Error("nextWeekdayMatching: allowedWeekdays is empty");
  }
  for (const d of allowedWeekdays) {
    if (d < 0 || d > 6) {
      throw new Error(`nextWeekdayMatching: invalid weekday ${d}`);
    }
  }
  const startWeekday = start.getUTCDay();
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = (startWeekday + offset) % 7;
    if (allowedWeekdays.includes(candidate)) {
      return new Date(start.getTime() + offset * MS_PER_DAY);
    }
  }
  // Unreachable when allowedWeekdays is non-empty + valid (a 7-day
  // window must hit every weekday at least once). The throw above
  // already guards both cases; this is belt-and-suspenders.
  throw new Error("nextWeekdayMatching: no matching weekday in 7 days");
}
