"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireStudent, requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { inngest } from "@/lib/inngest/client";
import { emitNotificationQueued } from "@/lib/notifications/events";
import {
  handleStudentCancel,
  handleTeacherCancel,
  type CancelEventEmitter,
} from "@/lib/cancellation/cancel-handler";
import { studentIdentityIds } from "@/lib/students/identity";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { revalidateAfterAction } from "@/lib/revalidate";
import { createT, issueMessage } from "@spiralclass/shared";

export type CancelState = { error?: string; ok?: string } | undefined;

// Cancel server actions. Auth + request validation live here; the
// data mutations and post-commit event emission are delegated to
// handleStudentCancel / handleTeacherCancel in @/lib/cancellation so
// they can be covered by integration tests without booting Next/Supabase.

const cancelInputSchema = z.object({
  bookingId: z.string().uuid(),
  // Optional quick-pick reason, from the pilot teacher's product issues — analytics
  // only, never persisted against the booking.
  reason: z.enum(["schedule_conflict", "no_longer_needed", "other"]).optional(),
});

const emitViaInngest: CancelEventEmitter = async (event) => {
  if (event.name === "notification.queued") {
    await emitNotificationQueued(event.data);
  } else {
    await inngest.send({ name: event.name, data: event.data });
  }
};

export async function cancelBookingAsStudent(
  _prev: CancelState,
  formData: FormData,
): Promise<CancelState> {
  const locale = await getPreferredLocale();
  const t = createT(locale);
  const parsed = cancelInputSchema.safeParse({
    bookingId: formData.get("bookingId"),
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) return { error: t("web.action.cancel.invalidBooking") };

  const student = await requireStudent();

  const outcome = await handleStudentCancel(
    { prisma, emit: emitViaInngest },
    { bookingId: parsed.data.bookingId, studentIds: await studentIdentityIds(student) },
  );

  if (outcome.code === "not-found") {
    return { error: t("web.action.bookingNotFound") };
  }
  if (outcome.code === "wrong-status") {
    return {
      error: t("web.action.cancel.student.wrongStatus"),
    };
  }
  if (outcome.code === "schedule-changes-exhausted") {
    return {
      error: t("web.action.cancel.student.changesExhausted"),
    };
  }

  trackServerEvent({
    name: "booking_canceled",
    distinctId: student.id,
    properties: {
      actor: "student",
      timing: outcome.timing,
      bookingId: outcome.bookingId,
      teacherId: outcome.teacherId,
      cancellationReason: parsed.data.reason,
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/my-classes/${outcome.bookingId}`);
  return {
    ok:
      outcome.timing === "lt24h"
        ? t("web.action.cancel.student.doneLate")
        : t("web.action.cancel.student.done"),
  };
}

// The message is a catalog key, turned into words by issueMessage(). It was a
// Spanish literal: a teacher reading the app in English or French who typed a
// two-letter reason was answered in Spanish.
const teacherCancelSchema = z.object({
  bookingId: z.string().uuid(),
  reason: z.string().trim().min(3, "web.action.reasonTooShort").max(500),
});

export async function cancelBookingAsTeacher(
  _prev: CancelState,
  formData: FormData,
): Promise<CancelState> {
  const locale = await getPreferredLocale();
  const t = createT(locale);
  const parsed = teacherCancelSchema.safeParse({
    bookingId: formData.get("bookingId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      error: issueMessage(parsed.error, t, "web.action.invalidData"),
    };
  }

  const teacher = await requireOnboardedTeacher();

  const outcome = await handleTeacherCancel(
    { prisma, emit: emitViaInngest },
    {
      bookingId: parsed.data.bookingId,
      teacherId: teacher.id,
      reason: parsed.data.reason,
    },
  );

  if (outcome.code === "not-found") {
    return { error: t("web.action.cancel.teacher.classNotFound") };
  }
  if (outcome.code === "wrong-status") {
    return {
      error: t("web.action.cancel.teacher.wrongStatus"),
    };
  }

  trackServerEvent({
    name: "booking_canceled",
    distinctId: teacher.id,
    properties: {
      actor: "teacher",
      timing: "teacher",
      bookingId: outcome.bookingId,
      teacherId: outcome.teacherId,
      cancellationReason: parsed.data.reason,
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/classes/${outcome.bookingId}`);
  return {
    ok: t("web.action.cancel.teacher.done"),
  };
}
