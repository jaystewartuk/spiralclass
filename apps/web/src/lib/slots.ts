// Slot generation — pure function implementing the pre-launch spec.
//
// The slot picker is package-scoped: a 50-min package and a 90-min package on
// the same day produce different grids. All DB rows arrive in UTC; we convert
// to the teacher's IANA zone to honor the algorithm's wall-clock semantics,
// then emit UTC instants on the way out.

import { addDays, addMinutes } from "date-fns";
import { intervalsOverlap, normalizeInputDate, weekdayInZone, zonedWallClockToUtc } from "./tz";

export type SlotTeacher = {
  timezone: string;
  bufferMin: number;
  minAdvanceH: number;
  maxAdvanceDays: number;
};

export type SlotAvailabilityRule = {
  weekday: number; // 0 = Sunday .. 6 = Saturday, in the rule's own timezone
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  // IANA zone the weekday + wall-clock were written in, frozen at write time
  // (D-53). Slot math interprets the rule in THIS zone rather than the live
  // Teacher.timezone, so a teacher relocating and changing their zone can't
  // silently reinterpret the rule (and desync it from booked UTC instants).
  timezone: string;
};

export type SlotBlockedDate = {
  startsAt: Date; // UTC
  endsAt: Date; // UTC
};

export type SlotExistingBooking = {
  scheduledStart: Date; // UTC
  scheduledEnd: Date; // UTC
  // The buffer frozen on THIS booking at insert time (Booking.bufferMinSnapshot),
  // which is what the DB `bookings_no_overlap_buffered` EXCLUDE constraint uses
  // (buffered_end = scheduled_end + buffer_min_snapshot). The picker must guard
  // each existing booking by its own snapshot, not the teacher's current buffer:
  // after a teacher LOWERS their buffer, an existing booking still reserves its
  // larger frozen zone, and using the current (smaller) buffer here would offer
  // a slot the DB then deterministically rejects (surfaced as a misleading
  // "booked by someone else"). Optional: absent → fall back to the current
  // buffer, which is exactly the prior behaviour and correct whenever the
  // snapshot equals the current buffer.
  bufferMinSnapshot?: number;
};

export type GenerateSlotsInput = {
  // The local calendar date (in the teacher's timezone) the student is
  // looking at. Accepts either a Date at the requested day or a YYYY-MM-DD
  // string; the latter avoids callers having to worry about timezones.
  date: Date | string;
  classDurationMin: number;
  teacher: SlotTeacher;
  availabilityRules: SlotAvailabilityRule[];
  blockedDates: SlotBlockedDate[];
  existingBookings: SlotExistingBooking[];
  now: Date;
};

export type Slot = {
  startUtc: Date;
  endUtc: Date;
};

function parseHHMM(hhmm: string): { h: number; m: number } {
  const [hStr, mStr] = hhmm.split(":");
  return { h: Number(hStr), m: Number(mStr) };
}

export function generateSlots(input: GenerateSlotsInput): Slot[] {
  const { classDurationMin, teacher, availabilityRules, blockedDates, existingBookings, now } =
    input;

  const minStart = addMinutes(now, teacher.minAdvanceH * 60);
  const maxStartUtc = addDays(now, teacher.maxAdvanceDays);

  const candidates: Slot[] = [];
  const step = classDurationMin + teacher.bufferMin;

  // Each rule is anchored in its OWN frozen zone (D-53), not the live
  // teacher.timezone — so a teacher who relocated and changed their zone keeps
  // generating the exact same UTC instants their existing bookings sit on. In
  // practice all of a teacher's rules share one zone (a save replaces the whole
  // set), but resolving per-rule keeps a mixed set correct too. teacher.timezone
  // remains a defensive fallback for a rule that somehow arrives without one.
  for (const rule of availabilityRules) {
    const tz = rule.timezone || teacher.timezone;
    // The requested calendar day, and its weekday, resolved in the rule's zone.
    const ymd = normalizeInputDate(input.date, tz);
    const localMidnightUtc = zonedWallClockToUtc(ymd, "00:00", tz);
    if (rule.weekday !== weekdayInZone(localMidnightUtc, tz)) continue;

    const ruleStart = parseHHMM(rule.startTime);
    const ruleEnd = parseHHMM(rule.endTime);
    const ruleStartMin = ruleStart.h * 60 + ruleStart.m;
    const ruleEndMin = ruleEnd.h * 60 + ruleEnd.m;

    for (let startMin = ruleStartMin; startMin + classDurationMin <= ruleEndMin; startMin += step) {
      const hh = String(Math.floor(startMin / 60)).padStart(2, "0");
      const mm = String(startMin % 60).padStart(2, "0");
      const startUtc = zonedWallClockToUtc(ymd, `${hh}:${mm}`, tz);
      const endUtc = addMinutes(startUtc, classDurationMin);
      candidates.push({ startUtc, endUtc });
    }
  }

  // Filter: blocked dates
  const notBlocked = candidates.filter(
    (c) => !blockedDates.some((b) => intervalsOverlap(c.startUtc, c.endUtc, b.startsAt, b.endsAt)),
  );

  // Filter: advance windows
  const inWindow = notBlocked.filter((c) => c.startUtc >= minStart && c.startUtc < maxStartUtc);

  // Filter: existing scheduled bookings. This mirrors the DB
  // `bookings_no_overlap_buffered` EXCLUDE constraint EXACTLY so the picker never
  // offers a slot the insert will reject: each booking reserves
  // [scheduled_start, scheduled_end + its OWN bufferMinSnapshot), and the new
  // candidate would reserve [start, end + the teacher's CURRENT buffer) (the
  // snapshot the insert will freeze onto it). Slot generation step 6.
  const candidateBufferMs = teacher.bufferMin * 60_000;
  const free = inWindow.filter((c) => {
    const candidateEndBuffered = new Date(c.endUtc.getTime() + candidateBufferMs);
    return !existingBookings.some((b) => {
      const existingBufferMs = (b.bufferMinSnapshot ?? teacher.bufferMin) * 60_000;
      const existingEndBuffered = new Date(b.scheduledEnd.getTime() + existingBufferMs);
      return intervalsOverlap(
        c.startUtc,
        candidateEndBuffered,
        b.scheduledStart,
        existingEndBuffered,
      );
    });
  });

  free.sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());

  // Collapse identical start instants. Two availability rules that overlap on
  // the same weekday (Wed 09:00-12:00 and Wed 10:00-13:00) each independently
  // emit a candidate at 10:00 and 11:00, and nothing downstream de-duplicates:
  // the blocked/window/booking filters all keep or drop both copies together,
  // so the student's picker lists the same time twice and React sees duplicate
  // keys (the slot lists key on `startUtc.toISOString()`). The web save path
  // rejects overlapping ranges via the shared `availabilitySchema`, but rules
  // can still reach here from other writers and from rows saved before that
  // check existed — so the generator itself has to be idempotent about it.
  // Sorted above, so duplicates are adjacent.
  return free.filter(
    (slot, i) => i === 0 || slot.startUtc.getTime() !== free[i - 1].startUtc.getTime(),
  );
}
