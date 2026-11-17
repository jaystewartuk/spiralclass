// "The clocks have changed since your last class" — issue 229.
//
// A teacher's availability is anchored in her own zone (D-53), so her weekly
// class stays at the same time on HER clock across her clock change. A student
// whose country changes on another weekend, or not at all, sees the same class
// move by an hour on theirs. Every time shown is already right (bookings are UTC
// instants); what was missing is saying that the time MOVED, so a student who
// has learned "my class is at 16:00" does not arrive an hour early or late.
//
// The test is the gap between the two parties' UTC offsets, read at each class's
// own instant, compared with the same gap at the pairing's previous class. A
// change in that gap is exactly the amount a class at the same time on one
// person's clock moved on the other's. Nothing here moves a class or reads a
// rule; it only describes two instants that already exist.
//
// Display only. An unknown student zone yields no note at all: computing in a
// guessed zone (the teacher's, or FALLBACK_TIMEZONE) would announce a move the
// student may never see.

import { zoneOffsetMinutes } from "./dual-zone";
import { DEFAULT_LOCALE, intlLocale, matchAcceptLanguage } from "./i18n/locales";
import type { TFunction } from "./i18n/translate-core";

/**
 * How far a class at the same time on the teacher's clock moved on the
 * student's clock between `previous` and `next`, in minutes. Positive: later on
 * the student's clock. Zero when nothing moved, and for an id the engine cannot
 * resolve — this only ever drives a notice, and a broken id is no basis for one.
 */
export function clockChangeShiftMinutes(
  previous: Date,
  next: Date,
  studentTz: string,
  teacherTz: string,
): number {
  if (studentTz === teacherTz) return 0;
  try {
    const gap = (at: Date) => zoneOffsetMinutes(studentTz, at) - zoneOffsetMinutes(teacherTz, at);
    return gap(next) - gap(previous);
  } catch {
    return 0;
  }
}

/**
 * A class that took place or will take place, and so is something a person
 * remembers the time of. A canceled class never happened, and a `rescheduled`
 * row is the old slot of a class that now lives on another row.
 */
const REFERENCE_STATUSES = new Set(["scheduled", "completed", "no_show"]);

export interface ClockChangeBooking {
  id: string;
  /** Groups one teacher–student pairing; the previous class is looked for within it. */
  pairKey: string;
  scheduledStart: Date;
  status: string;
}

/**
 * For each class, the shift since the class before it in the same pairing —
 * only the non-zero ones. Pass every class the screen shows together with the
 * pairing's class just before the first of them, so the first has a reference.
 * Classes that are not themselves a reference (canceled, moved) get no entry.
 */
export function clockChangeShiftsByBooking<T extends ClockChangeBooking>(
  bookings: readonly T[],
  zonesFor: (booking: T) => { studentTz: string | null; teacherTz: string },
): Map<string, number> {
  const shifts = new Map<string, number>();
  const lastByPair = new Map<string, T>();
  const ordered = [...bookings]
    .filter((b) => REFERENCE_STATUSES.has(b.status))
    .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());
  for (const booking of ordered) {
    const previous = lastByPair.get(booking.pairKey);
    lastByPair.set(booking.pairKey, booking);
    if (!previous) continue;
    const { studentTz, teacherTz } = zonesFor(booking);
    if (!studentTz) continue;
    const shift = clockChangeShiftMinutes(
      previous.scheduledStart,
      booking.scheduledStart,
      studentTz,
      teacherTz,
    );
    if (shift !== 0) shifts.set(booking.id, shift);
  }
  return shifts;
}

/** The size of a shift in words, unsigned: "1 hour", "2 horas", "30 minutes". */
export function formatClockShift(minutes: number, locale?: string | null): string {
  const tag = intlLocale(matchAcceptLanguage(locale) ?? DEFAULT_LOCALE);
  const size = Math.abs(minutes);
  const wholeHours = size % 60 === 0;
  return new Intl.NumberFormat(tag, {
    style: "unit",
    unit: wholeHours ? "hour" : "minute",
    unitDisplay: "long",
  }).format(wholeHours ? size / 60 : size);
}

/**
 * The sentence for a shift, from the reader's side. `shiftMinutes` is always
 * the student-side value from clockChangeShiftMinutes; the teacher's copy
 * describes the same move on the student's clock, so she is not surprised by an
 * early or late arrival. `otherName` is the other party. Null when nothing moved.
 */
export function clockChangeNote(
  t: TFunction,
  locale: string,
  viewer: "student" | "teacher",
  shiftMinutes: number,
  otherName: string,
): string | null {
  if (shiftMinutes === 0) return null;
  const amount = formatClockShift(shiftMinutes, locale);
  const later = shiftMinutes > 0;
  if (viewer === "student") {
    return t(later ? "clockChange.student.later" : "clockChange.student.earlier", {
      teacherName: otherName,
      amount,
    });
  }
  return t(later ? "clockChange.teacher.later" : "clockChange.teacher.earlier", {
    studentName: otherName,
    amount,
  });
}
