import type { PrismaClient } from "@prisma/client";
import { loadGoogleBusyBlocks } from "@/lib/calendar/google/busy";

// Loads everything `generateSlots` needs to compute availability for a teacher
// across a date window, in one burst. Used by the single-class pay-at-
// reservation flow, which generates the grid client-side (generateSlots is a
// pure function) so the student can pick a slot before paying without a server
// round-trip per day. The shape is intentionally serializable (ISO strings for
// instants) so a server component can hand it straight to a client component.

export type SlotInputsWire = {
  availabilityRules: Array<{
    weekday: number;
    startTime: string;
    endTime: string;
    // Frozen IANA zone the rule was written in (D-53) — generateSlots
    // interprets the rule in this zone, not the live teacher zone.
    timezone: string;
  }>;
  // UTC instants as ISO strings — blocked dates and Google busy intervals are
  // merged here since generateSlots treats them identically.
  blockedDates: Array<{ startsAt: string; endsAt: string }>;
  existingBookings: Array<{
    scheduledStart: string;
    scheduledEnd: string;
    // Frozen per-booking buffer (Booking.bufferMinSnapshot) so the client grid
    // guards each booking by the same zone the DB constraint uses — see
    // generateSlots / SlotExistingBooking.
    bufferMinSnapshot: number;
  }>;
};

export async function loadSlotInputs(
  prisma: Pick<PrismaClient, "availabilityRule" | "blockedDate" | "googleBusyInterval" | "booking">,
  teacherId: string,
  windowStartUtc: Date,
  windowEndUtc: Date,
): Promise<SlotInputsWire> {
  // Pad the window by a day on each side so slots near the boundary (which the
  // generator anchors to the teacher's local day) aren't dropped by a UTC edge.
  const lo = new Date(windowStartUtc.getTime() - 24 * 3600_000);
  const hi = new Date(windowEndUtc.getTime() + 48 * 3600_000);

  const [rules, blocked, googleBusy, bookings] = await Promise.all([
    prisma.availabilityRule.findMany({ where: { teacherId } }),
    prisma.blockedDate.findMany({
      where: { teacherId, endsAt: { gt: lo }, startsAt: { lt: hi } },
      select: { startsAt: true, endsAt: true },
    }),
    loadGoogleBusyBlocks(teacherId, prisma),
    prisma.booking.findMany({
      where: {
        teacherId,
        status: "scheduled",
        scheduledStart: { gte: lo, lt: hi },
      },
      select: { scheduledStart: true, scheduledEnd: true, bufferMinSnapshot: true },
    }),
  ]);

  return {
    availabilityRules: rules.map((r) => ({
      weekday: r.weekday,
      startTime: r.startTime,
      endTime: r.endTime,
      timezone: r.timezone,
    })),
    blockedDates: [...blocked, ...googleBusy].map((b) => ({
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
    })),
    existingBookings: bookings.map((b) => ({
      scheduledStart: b.scheduledStart.toISOString(),
      scheduledEnd: b.scheduledEnd.toISOString(),
      bufferMinSnapshot: b.bufferMinSnapshot,
    })),
  };
}
