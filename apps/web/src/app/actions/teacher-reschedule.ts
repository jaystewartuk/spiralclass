"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { generateSlots } from "@/lib/slots";
import { loadGoogleBusyBlocks } from "@/lib/calendar/google/busy";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { inngest } from "@/lib/inngest/client";
import {
  applyReschedule,
  type RescheduleEventEmitter,
} from "@/lib/cancellation/reschedule-handler";
import type { TeacherRescheduleError } from "@/lib/cancellation/teacher-reschedule-errors";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { revalidateAfterAction } from "@/lib/revalidate";

/**
 * Teacher-initiated reschedule — "change the date and time of a class".
 *
 * Until now moving a class was something only the student could do; a teacher
 * whose Tuesday fell through had to cancel the class and book a replacement,
 * which is two screens, loses the link between the old class and the new one
 * (`rescheduleOfBookingId`), and sends the student a cancellation rather than
 * a change of time. This is the same move as the student's, done from her side.
 *
 * WHAT SHE IS EXEMPT FROM, and what she is not. She is exempt from the two
 * rules that exist to bound what a STUDENT can do unilaterally:
 *   * the ≥24h window — the class she needs to move is very often tomorrow's,
 *     and refusing her is refusing the only person who can fix it; and
 *   * the package's pooled schedule-change budget, which is not spent
 *     (`spendScheduleChange: false`). Charging the student's allowance for a
 *     change the teacher made would take away a move the student never used,
 *     and mirrors nothing: `handleTeacherCancel` refunds without charging it
 *     either.
 * She is NOT exempt from anything that describes reality: her own availability
 * windows, blocked dates, Google busy blocks, the buffer between classes,
 * collisions with other students, her max-advance horizon, or the package's
 * expiration. The single generator rule she bypasses is her own `minAdvanceH`
 * — the same bypass `createTeacherBooking` takes, and for the same reason
 * (she is confirming something already agreed, not booking against herself).
 *
 * The student is always notified. A class must never move under her silently,
 * so `reschedule_confirm` is enqueued exactly as for a student-initiated move,
 * carrying the OLD time for context. The teacher's own mirror is skipped —
 * she is the one who did it.
 */
export type TeacherRescheduleState = { error?: TeacherRescheduleError } | undefined;

const teacherRescheduleSchema = z.object({
  bookingId: z.string().uuid(),
  startUtc: z.string().datetime(),
});

const emitViaInngest: RescheduleEventEmitter = async (event) => {
  if (event.name === "notification.queued") {
    await emitNotificationQueued(event.data);
  } else {
    await inngest.send({ name: event.name, data: event.data });
  }
};

export async function rescheduleBookingAsTeacher(
  _prev: TeacherRescheduleState,
  formData: FormData,
): Promise<TeacherRescheduleState> {
  const parsed = teacherRescheduleSchema.safeParse({
    bookingId: formData.get("bookingId"),
    startUtc: formData.get("startUtc"),
  });
  if (!parsed.success) return { error: "invalid" };

  const teacher = await requireOnboardedTeacher();

  // Tenant isolation: the booking is scoped to the authenticated teacher.
  // There is no RLS behind this (see CLAUDE.md) — this filter is the whole
  // of it.
  const old = await prisma.booking.findFirst({
    where: { id: parsed.data.bookingId, teacherId: teacher.id },
    select: {
      id: true,
      teacherId: true,
      studentId: true,
      packageId: true,
      status: true,
      scheduledStart: true,
      rescheduleCount: true,
      package: { select: { classDurationMin: true, expiresAt: true } },
    },
  });
  if (!old) return { error: "booking-not-found" };
  // Only a class that is still going to happen can be moved. A completed or
  // no-show class is history and its status is time-driven (classes complete
  // at their end time); "rescheduling" one would be a second, manual way to
  // reopen a finished class, which is not what this is for. Restoring a
  // cancelled class is `restoreClass`, and it already exists.
  if (old.status !== "scheduled") return { error: "not-scheduled" };

  const now = new Date();
  const newStartUtc = new Date(parsed.data.startUtc);
  if (newStartUtc <= now) return { error: "past-slot" };
  // Moving a class to the time it already has is a no-op that would still
  // burn an audit row and tell the student her class had changed.
  if (newStartUtc.getTime() === old.scheduledStart.getTime()) return { error: "same-slot" };

  const newEndUtc = new Date(newStartUtc.getTime() + old.package.classDurationMin * 60_000);

  // The credit funding this class cannot outlive the package that holds it.
  // She can move the expiry itself (Edit package → Expires) and then move the
  // class; the two are deliberately separate decisions.
  if (old.package.expiresAt && newStartUtc > old.package.expiresAt) {
    return { error: "package-expired" };
  }

  // Re-validate the slot through the generator — the picker's list is a
  // snapshot, this read is the authority (same chain as createBooking and
  // rescheduleBooking).
  const dayBefore = new Date(newStartUtc.getTime() - 24 * 3600_000);
  const dayAfter = new Date(newStartUtc.getTime() + 24 * 3600_000);
  const [rules, blocked, googleBusy, bookings] = await Promise.all([
    prisma.availabilityRule.findMany({ where: { teacherId: old.teacherId } }),
    prisma.blockedDate.findMany({
      where: { teacherId: old.teacherId, endsAt: { gt: dayBefore }, startsAt: { lt: dayAfter } },
    }),
    loadGoogleBusyBlocks(old.teacherId, prisma),
    prisma.booking.findMany({
      where: {
        teacherId: old.teacherId,
        status: "scheduled",
        scheduledStart: { gte: dayBefore, lt: dayAfter },
        // The class being moved must not block its own replacement — it is
        // flipped to `rescheduled` inside the same transaction, but the
        // collision check cannot see that yet.
        NOT: { id: old.id },
      },
      select: { scheduledStart: true, scheduledEnd: true, bufferMinSnapshot: true },
    }),
  ]);
  const candidates = generateSlots({
    date: newStartUtc,
    classDurationMin: old.package.classDurationMin,
    teacher: {
      timezone: teacher.timezone,
      bufferMin: teacher.bufferMin,
      // The one rule she bypasses — see the doc comment above.
      minAdvanceH: 0,
      maxAdvanceDays: teacher.maxAdvanceDays,
    },
    availabilityRules: rules,
    blockedDates: [...blocked, ...googleBusy],
    existingBookings: bookings,
    now,
  });
  if (!candidates.some((c) => c.startUtc.getTime() === newStartUtc.getTime())) {
    return { error: "slot-unavailable" };
  }

  const t = await getT();
  const outcome = await applyReschedule(
    { prisma, emit: emitViaInngest },
    {
      oldBookingId: old.id,
      teacherId: old.teacherId,
      studentId: old.studentId,
      packageId: old.packageId,
      oldScheduledStart: old.scheduledStart,
      oldRescheduleCount: old.rescheduleCount,
      newStartUtc,
      newEndUtc,
      bufferMin: teacher.bufferMin,
      // Her move, not the student's allowance.
      spendScheduleChange: false,
      // She did it; she does not need telling that she did it.
      notifyTeacher: false,
      // Recorded like every other teacher intervention, so it shows up in the
      // class history the student can read. Resolved through the catalog with
      // her own `t` rather than an `en ? … : …` ternary, which would have
      // written Spanish into the log of every teacher who is not English.
      override: {
        action: "teacher_reschedule_class",
        reason: t("teacherReschedule.overrideReason"),
      },
    },
  );

  if (outcome.code === "slot-conflict") return { error: "slot-taken" };
  if (outcome.code === "package-not-found") return { error: "package-not-found" };

  trackServerEvent({
    name: "reschedule_completed",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      oldBookingId: old.id,
      newBookingId: outcome.newBookingId,
      actor: "teacher",
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/classes/${old.id}`);
  redirect(`/dashboard/classes/${outcome.newBookingId}`);
}
