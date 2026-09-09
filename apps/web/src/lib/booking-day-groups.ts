// Groups a list of bookings by calendar day (Today / Tomorrow / weekday date)
// in a single reference timezone, so a long list always scans the same way.
import { toYMD } from "@/lib/tz";
import { shiftDay } from "@/lib/calendar-grid";
import { formatZonedDayHeader } from "@/lib/date-display";
import type { AppLocale } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";

export type BookingDayGroup<T> = {
  ymd: string;
  label: string;
  /**
   * Which of the two named days this is, if either — so a caller can give
   * today's group more weight than a date three weeks out without re-deriving
   * the comparison from the label string.
   */
  relative: "today" | "tomorrow" | null;
  items: T[];
};

export function groupBookingsByDay<T extends { scheduledStart: Date }>(
  bookings: T[],
  tz: string,
  locale: AppLocale,
  now: Date,
  t: TFunction,
): BookingDayGroup<T>[] {
  const todayYmd = toYMD(now, tz);
  // Calendar-day increment, not a fixed +24h: in a DST-observing display zone
  // (e.g. America/Tijuana) a 23- or 25-hour day means now + 86,400,000 ms can
  // land on today or the day after tomorrow, mislabeling the "Tomorrow" group.
  const tomorrowYmd = shiftDay(todayYmd, 1);

  const groups: BookingDayGroup<T>[] = [];
  for (const booking of bookings) {
    const ymd = toYMD(booking.scheduledStart, tz);
    let group = groups.find((g) => g.ymd === ymd);
    if (!group) {
      // The two named days come from the catalog rather than an inline
      // en/es ternary. That ternary was `locale === "en" ? "Today" : "Hoy"`,
      // which printed "Hoy" to a French reader on both the teacher list and
      // the student portal — while `classes.group.today` had a correct
      // "Aujourd'hui" sitting in the catalog the whole time.
      const relative = ymd === todayYmd ? "today" : ymd === tomorrowYmd ? "tomorrow" : null;
      const label =
        relative === "today"
          ? t("classes.group.today")
          : relative === "tomorrow"
            ? t("classes.group.tomorrow")
            : formatZonedDayHeader(booking.scheduledStart, tz, locale);
      group = { ymd, label, relative, items: [] };
      groups.push(group);
    }
    group.items.push(booking);
  }
  return groups;
}
