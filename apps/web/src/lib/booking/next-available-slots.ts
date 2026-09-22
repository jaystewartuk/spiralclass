// Find the first day with open slots, searching forward from a fixed anchor
// day, against ONE pre-fetched window of DB data (see loadSlotInputs) instead
// of a fresh query per candidate day. This is the shared engine behind both
// mobile "next available" endpoints (student/slots/next-available,
// student/bookings/[id]/reschedule-slots/next-available) — the web RSC pages
// (my-classes/book, my-classes/[bookingId]/reschedule) already do the
// equivalent inline since they run server-side anyway; mobile is a client
// hitting HTTP, so it needed dedicated endpoints wrapping the same idea.
//
// Kept separate from the route handlers so the actual day-walk + slot
// generation is unit-testable without a database — mirrors firstAvailableDay
// in next-available.ts, just also returning the winning day's slots instead
// of only its date.

import { generateSlots, type GenerateSlotsInput, type Slot } from "@/lib/slots";
import { addCalendarDays } from "./next-available";
import type { SlotInputsWire } from "./slot-inputs";

export type NextAvailableSlotsResult = { date: string; slots: Slot[] } | null;

export function findNextAvailableSlots(
  inputs: SlotInputsWire,
  params: {
    // The day search starts AFTER, not the first day checked — matches the
    // mobile screens' prior loop (`for i = 1..horizon: shiftDay(today, i)`),
    // which always searches strictly forward of "today" regardless of
    // whichever day is currently on screen.
    anchorYmd: string;
    horizonDays: number;
    classDurationMin: number;
    teacher: GenerateSlotsInput["teacher"];
    now: Date;
  },
  // Applied to each day's generated slots before checking non-emptiness —
  // e.g. reschedule excludes the original slot and anything past package
  // expiry (see the route for why).
  filter?: (s: Slot) => boolean,
): NextAvailableSlotsResult {
  // Rehydrate once: generateSlots wants Date objects, loadSlotInputs's wire
  // format is ISO strings (so it can also travel to a client component, see
  // class-slot-picker.tsx's identical rehydration).
  const blockedDates = inputs.blockedDates.map((b) => ({
    startsAt: new Date(b.startsAt),
    endsAt: new Date(b.endsAt),
  }));
  const existingBookings = inputs.existingBookings.map((b) => ({
    scheduledStart: new Date(b.scheduledStart),
    scheduledEnd: new Date(b.scheduledEnd),
    bufferMinSnapshot: b.bufferMinSnapshot,
  }));

  for (let i = 1; i <= params.horizonDays; i++) {
    const day = addCalendarDays(params.anchorYmd, i);
    let slots = generateSlots({
      date: day,
      classDurationMin: params.classDurationMin,
      teacher: params.teacher,
      availabilityRules: inputs.availabilityRules,
      blockedDates,
      existingBookings,
      now: params.now,
    });
    if (filter) slots = slots.filter(filter);
    if (slots.length > 0) return { date: day, slots };
  }
  return null;
}
