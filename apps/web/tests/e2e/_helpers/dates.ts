// A YYYY-MM-DD date `daysAhead` from today, rolled forward to the next weekday
// (the seeded teachers' availability is Mon–Fri). Used to book a ≥24h-out class
// so it's reschedule-eligible (a <24h class hides the "Reagendar" link / fails
// the reschedule eligibility check). Extracted verbatim from
// cancel-reschedule.spec.ts.
export function nextWeekdayISO(daysAhead: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
