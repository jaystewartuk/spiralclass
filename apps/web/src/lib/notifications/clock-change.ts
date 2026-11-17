import type { Prisma, PrismaClient } from "@prisma/client";
import {
  clockChangeNote,
  clockChangeShiftMinutes,
  createT,
  languageCodeToLocale,
  localeToLanguageCode,
} from "@spiralclass/shared";
import { logger } from "@/lib/logger";

// The reminder side of "the clocks have changed since your last class"
// (issue 229; the rule and its copy live in packages/shared/src/clock-change.ts).
//
// The shift is measured once, when the reminder rows are enqueued, and carried
// in their metadata, so the dispatcher and the in-app inbox render the same
// sentence without a query per row — and the inbox can never say something the
// reminder did not.

type Db = Prisma.TransactionClient | PrismaClient;

/** Booking statuses that count as "your last class" — see clockChangeShiftsByBooking. */
const REFERENCE_STATUSES = ["scheduled", "completed", "no_show"] as const;

/**
 * Minutes a class at the same time on the teacher's clock moved on the
 * student's clock since the pairing's previous class; 0 when nothing moved,
 * there is no previous class, or the student's zone is unknown.
 *
 * Best-effort: a reminder must never fail because its footnote could not be
 * worked out, so any error reads as "nothing moved".
 */
export async function reminderClockShiftMinutes(
  db: Db,
  input: { bookingId: string; teacherId: string; studentId: string },
): Promise<number> {
  try {
    // Tenant isolation: both reads are scoped to this teacher.
    const booking = await db.booking.findFirst({
      where: { id: input.bookingId, teacherId: input.teacherId },
      select: {
        scheduledStart: true,
        teacher: { select: { timezone: true } },
        student: { select: { timezone: true } },
      },
    });
    const studentTz = booking?.student?.timezone;
    const teacherTz = booking?.teacher?.timezone;
    if (!booking?.scheduledStart || !studentTz || !teacherTz) return 0;
    const previous = await db.booking.findFirst({
      where: {
        teacherId: input.teacherId,
        studentId: input.studentId,
        id: { not: input.bookingId },
        status: { in: [...REFERENCE_STATUSES] },
        scheduledStart: { lt: booking.scheduledStart },
      },
      orderBy: { scheduledStart: "desc" },
      select: { scheduledStart: true },
    });
    if (!previous) return 0;
    return clockChangeShiftMinutes(
      previous.scheduledStart,
      booking.scheduledStart,
      studentTz,
      teacherTz,
    );
  } catch (error) {
    logger({ surface: "clock-change" }).warn("clock-change shift lookup failed", {
      bookingId: input.bookingId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/** What the reminder rows carry. Absent when nothing moved. */
export type ReminderMetadata = { clockShiftMinutes?: number };

/** Reads the shift back off a reminder row's metadata; 0 for anything unexpected. */
export function clockShiftFromMetadata(metadata: Prisma.JsonValue | null): number {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return 0;
  const value = (metadata as ReminderMetadata).clockShiftMinutes;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The sentence for a reminder, in the recipient's language, or undefined. */
export function reminderClockChangeNote(
  metadata: Prisma.JsonValue | null,
  viewer: "student" | "teacher",
  recipientLocale: string,
  otherName: string,
): string | undefined {
  const shift = clockShiftFromMetadata(metadata);
  if (shift === 0) return undefined;
  const locale = languageCodeToLocale(localeToLanguageCode(recipientLocale));
  return clockChangeNote(createT(locale), locale, viewer, shift, otherName) ?? undefined;
}
