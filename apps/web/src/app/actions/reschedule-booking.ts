"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireStudent } from "@/lib/auth";
import { generateSlots } from "@/lib/slots";
import { loadGoogleBusyBlocks } from "@/lib/calendar/google/busy";
import { getPreferredLocale } from "@/lib/i18n";
import { canStudentRescheduleBooking, scheduleChangeBudget } from "@/lib/cancellation/classify";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { inngest } from "@/lib/inngest/client";
import {
  applyReschedule,
  type RescheduleEventEmitter,
} from "@/lib/cancellation/reschedule-handler";
import { studentIdentityIds } from "@/lib/students/identity";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { revalidateAfterAction } from "@/lib/revalidate";
import { createT, type TFunction } from "@spiralclass/shared";

export type RescheduleState = { error?: string } | undefined;

const rescheduleInputSchema = z.object({
  bookingId: z.string().uuid(),
  startUtc: z.string().datetime(),
});

// Reschedule server action. Auth + eligibility + slot-availability
// checks live here; the transaction + event emission are delegated to
// applyReschedule in @/lib/cancellation/reschedule-handler so they can be
// covered by integration tests without booting Next/Supabase.
const emitViaInngest: RescheduleEventEmitter = async (event) => {
  if (event.name === "notification.queued") {
    await emitNotificationQueued(event.data);
  } else {
    await inngest.send({ name: event.name, data: event.data });
  }
};

export async function rescheduleBooking(
  _prev: RescheduleState,
  formData: FormData,
): Promise<RescheduleState> {
  const t = createT(await getPreferredLocale());
  const parsed = rescheduleInputSchema.safeParse({
    bookingId: formData.get("bookingId"),
    startUtc: formData.get("startUtc"),
  });
  if (!parsed.success) return { error: t("web.action.invalidSelection") };

  const student = await requireStudent();

  const old = await prisma.booking.findFirst({
    where: { id: parsed.data.bookingId, studentId: { in: await studentIdentityIds(student) } },
    include: {
      teacher: true,
      package: true,
    },
  });
  if (!old) return { error: t("web.action.bookingNotFound") };

  const now = new Date();
  const eligibility = canStudentRescheduleBooking({
    now,
    scheduledStart: old.scheduledStart,
    status: old.status,
    scheduleChangesUsed: old.package.scheduleChangesUsed,
    scheduleChangesAllowed: scheduleChangeBudget(old.package.classesTotal),
  });
  if (!eligibility.ok) {
    return { error: rejectReason(eligibility.reason, t) };
  }

  const newStartUtc = new Date(parsed.data.startUtc);
  if (newStartUtc <= now) return { error: t("web.action.reschedule.futureSlot") };

  const newEndUtc = new Date(newStartUtc.getTime() + old.package.classDurationMin * 60_000);

  // Review item 15: the same-week (Mon–Sun) restriction is gone — a class
  // can move to any slot the student could book fresh. The package's
  // validity window still applies (previously implicit while reschedules
  // were capped to the original week).
  if (old.package.expiresAt && newStartUtc > old.package.expiresAt) {
    return {
      error: t("web.action.reschedule.beforeExpiry"),
    };
  }

  // Re-validate the slot via slot generation — same path as createBooking.
  const dayBefore = new Date(newStartUtc.getTime() - 24 * 3600_000);
  const dayAfter = new Date(newStartUtc.getTime() + 24 * 3600_000);
  const [rules, blocked, googleBusy, bookings] = await Promise.all([
    prisma.availabilityRule.findMany({ where: { teacherId: old.teacherId } }),
    prisma.blockedDate.findMany({
      where: {
        teacherId: old.teacherId,
        endsAt: { gt: dayBefore },
        startsAt: { lt: dayAfter },
      },
    }),
    // Google busy-import (Phase 3): empty unless the teacher connected Google.
    loadGoogleBusyBlocks(old.teacherId, prisma),
    prisma.booking.findMany({
      where: {
        teacherId: old.teacherId,
        status: "scheduled",
        scheduledStart: { gte: dayBefore, lt: dayAfter },
        // Don't let the old booking itself block its successor (we'll mark
        // it `rescheduled` in the same tx, but the slot-collision check
        // doesn't know that yet).
        NOT: { id: old.id },
      },
      // Guard each booking by its own frozen buffer (matches the DB overlap
      // constraint) so the picker doesn't offer a slot the insert rejects.
      select: { scheduledStart: true, scheduledEnd: true, bufferMinSnapshot: true },
    }),
  ]);
  const candidates = generateSlots({
    date: newStartUtc,
    classDurationMin: old.package.classDurationMin,
    teacher: {
      timezone: old.teacher.timezone,
      bufferMin: old.teacher.bufferMin,
      minAdvanceH: old.teacher.minAdvanceH,
      maxAdvanceDays: old.teacher.maxAdvanceDays,
    },
    availabilityRules: rules,
    blockedDates: [...blocked, ...googleBusy],
    existingBookings: bookings,
    now,
  });
  const match = candidates.find((c) => c.startUtc.getTime() === newStartUtc.getTime());
  if (!match)
    return {
      error: t("web.action.slotUnavailable"),
    };

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
      bufferMin: old.teacher.bufferMin,
    },
  );

  if (outcome.code === "slot-conflict") {
    return {
      error: t("web.action.slotTaken"),
    };
  }

  if (outcome.code === "package-not-found") {
    return {
      error: t("web.action.reschedule.packageGone"),
    };
  }

  trackServerEvent({
    name: "reschedule_completed",
    distinctId: student.id,
    properties: {
      teacherId: old.teacherId,
      oldBookingId: old.id,
      newBookingId: outcome.newBookingId,
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/my-classes/${old.id}`);
  redirect(`/my-classes/${outcome.newBookingId}`);
}

function rejectReason(reason: string, t: TFunction): string {
  switch (reason) {
    case "booking-not-scheduled":
      return t("web.action.reschedule.notScheduled");
    case "schedule-changes-exhausted":
      return t("web.action.reschedule.changesExhausted");
    case "lt24h":
      return t("web.action.reschedule.lt24h");
    default:
      return t("web.action.reschedule.notAllowed");
  }
}
