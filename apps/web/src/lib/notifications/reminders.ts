import { prisma } from "@/lib/prisma";
import { enqueueReminder, enqueueReminderTeacher } from "@/lib/notifications/enqueue";
import { enqueueMaterialsForTiming } from "@/lib/notifications/materials";
import { emitNotificationQueued } from "@/lib/notifications/events";

// Reminder dispatch core. Extracted from the former
// lib/inngest/functions/schedule-reminders.ts when reminders moved from a
// per-booking durable-timer fan-out to a due-scanning cron
// (docs/architecture/overview.md). `maybeEnqueueReminder`
// is called once per due (booking, leg) pair by lib/notifications/reminder-scan.ts;
// it re-checks the booking's live state and dedupes at the row level so a leg
// re-evaluated on every cron tick only ever sends once.

// There is deliberately no "5d" leg: teachers asked for the five-days-before
// class reminder to be removed outright (it fired too far out to be actionable
// and read as noise on both sides), so neither the student nor the teacher gets
// one. The 5-day MARK still exists in the scan, but only to release `t_5d`
// class materials — see maybeEnqueueFiveDayMaterials below.
export type ReminderLeg = "24h" | "1h" | "15m";

// Reminder leg → template name. Kept in sync with enqueueReminder's own
// mapping (src/lib/notifications/enqueue.ts); used for the dedup lookup.
function reminderTemplateName(which: ReminderLeg): string {
  return which === "24h" ? "reminder_24h" : which === "1h" ? "reminder_1h" : "reminder_15m";
}

// Teacher-recipient variant of the above — kept in sync with
// enqueueReminderTeacher; used for the teacher leg's dedup lookup.
function reminderTemplateNameTeacher(which: ReminderLeg): string {
  return `${reminderTemplateName(which)}_teacher`;
}

// Re-checks the booking's live state at dispatch time and enqueues the reminder
// + any matching materials, or short-circuits when the booking is no longer
// scheduled (canceled/rescheduled/deleted). Idempotent: one reminder per
// (bookingId, templateName) for each of the teacher + student legs, so a leg
// re-evaluated by the scan cron on every tick — or a redelivered trigger —
// can't double-send.
export async function maybeEnqueueReminder(input: {
  bookingId: string;
  teacherId: string;
  studentId: string;
  which: ReminderLeg;
}): Promise<{ sent: boolean; reason?: string; materialIds?: string[] }> {
  // Tenant isolation: filter by teacher_id even on the service-role connection.
  const booking = await prisma.booking.findFirst({
    where: { id: input.bookingId, teacherId: input.teacherId },
    select: { status: true },
  });
  if (!booking || booking.status !== "scheduled") {
    return { sent: false, reason: `booking-status:${booking?.status ?? "missing"}` };
  }

  // Teacher leg — the teacher gets the same pre-class reminder about her own
  // upcoming class. Deduped independently of the student leg (its own
  // (bookingId, templateName, teacher) row), so a partial retry re-attempts
  // whichever leg didn't land. Enqueued before the student early-return below
  // so a booking whose student reminder already exists still gets the teacher
  // one on a redelivery where only the student row was written.
  const teacherTemplateName = reminderTemplateNameTeacher(input.which);
  const existingTeacher = await prisma.notification.findFirst({
    where: {
      teacherId: input.teacherId,
      recipientType: "teacher",
      recipientId: input.teacherId,
      bookingId: input.bookingId,
      templateName: teacherTemplateName,
    },
    select: { id: true },
  });
  if (!existingTeacher) {
    const teacherNotificationId = await enqueueReminderTeacher(prisma, {
      teacherId: input.teacherId,
      bookingId: input.bookingId,
      which: input.which,
    });
    await emitNotificationQueued({
      notificationId: teacherNotificationId,
      teacherId: input.teacherId,
    });
  }

  // Student leg. This row is also the idempotency anchor for the timing-matched
  // materials below — when it already exists, both the student reminder and its
  // materials were enqueued on the first fire, so we short-circuit here.
  const templateName = reminderTemplateName(input.which);
  const existing = await prisma.notification.findFirst({
    where: {
      teacherId: input.teacherId,
      recipientType: "student",
      recipientId: input.studentId,
      bookingId: input.bookingId,
      templateName,
    },
    select: { id: true },
  });
  if (existing) {
    return { sent: false, reason: `duplicate:${templateName}` };
  }

  const notificationId = await enqueueReminder(prisma, {
    teacherId: input.teacherId,
    studentId: input.studentId,
    bookingId: input.bookingId,
    which: input.which,
  });
  await emitNotificationQueued({ notificationId, teacherId: input.teacherId });

  //: enqueue materials whose send_timing matches this
  // reminder leg. The 15m leg has no materials timing slot — skip it.
  // (`t_5d` has no reminder leg to ride on any more — it's released by
  // maybeEnqueueFiveDayMaterials below.)
  const timingMap = { "24h": "t_24h", "1h": "t_1h", "15m": null } as const;
  const timing = timingMap[input.which];
  if (!timing) return { sent: true, materialIds: [] };
  const materialIds = await enqueueMaterialsForTiming(prisma, {
    teacherId: input.teacherId,
    studentId: input.studentId,
    bookingId: input.bookingId,
    timing,
  });
  for (const id of materialIds) {
    await emitNotificationQueued({ notificationId: id, teacherId: input.teacherId });
  }
  return { sent: true, materialIds };
}

// Materials-only pass at the five-day mark.
//
// The 5-day class reminder is gone, but `t_5d` remains a send timing a teacher
// can pick for class materials, so something still has to fire at that offset.
// This is that something: no reminder row for either recipient, just the
// timing-matched materials.
//
// Idempotency differs from the reminder legs. Those anchor their dedup on the
// student reminder row they just wrote; with no such row here, the dedup lives
// inside enqueueMaterialsForTiming, which skips any material that already has a
// materials_send notification on this booking. Called once per due booking by
// lib/notifications/reminder-scan.ts, on every tick after the mark passes.
export async function maybeEnqueueFiveDayMaterials(input: {
  bookingId: string;
  teacherId: string;
  studentId: string;
}): Promise<{ sent: boolean; reason?: string; materialIds: string[] }> {
  // Tenant isolation: filter by teacher_id even on the service-role connection.
  const booking = await prisma.booking.findFirst({
    where: { id: input.bookingId, teacherId: input.teacherId },
    select: { status: true },
  });
  if (!booking || booking.status !== "scheduled") {
    return {
      sent: false,
      reason: `booking-status:${booking?.status ?? "missing"}`,
      materialIds: [],
    };
  }

  const materialIds = await enqueueMaterialsForTiming(prisma, {
    teacherId: input.teacherId,
    studentId: input.studentId,
    bookingId: input.bookingId,
    timing: "t_5d",
  });
  for (const id of materialIds) {
    await emitNotificationQueued({ notificationId: id, teacherId: input.teacherId });
  }
  return { sent: materialIds.length > 0, materialIds };
}
