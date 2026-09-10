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
  const en = locale === "en";
  const parsed = cancelInputSchema.safeParse({
    bookingId: formData.get("bookingId"),
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) return { error: en ? "Invalid booking." : "Reserva inválida." };

  const student = await requireStudent();

  const outcome = await handleStudentCancel(
    { prisma, emit: emitViaInngest },
    { bookingId: parsed.data.bookingId, studentIds: await studentIdentityIds(student) },
  );

  if (outcome.code === "not-found") {
    return { error: en ? "We couldn't find that booking." : "No encontramos esa reserva." };
  }
  if (outcome.code === "wrong-status") {
    return {
      error: en
        ? "This class can no longer be canceled from here. Ask your teacher to adjust it."
        : "Esta clase ya no se puede cancelar desde aquí. Pide a tu profe que la ajuste.",
    };
  }
  if (outcome.code === "schedule-changes-exhausted") {
    return {
      error: en
        ? "You've used all the schedule changes included with this package, so this class can't be refunded. To cancel it, ask your teacher."
        : "Ya usaste todos los cambios de horario incluidos en este paquete, así que esta clase no se puede reembolsar. Para cancelarla, pide a tu profe.",
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
    ok: en
      ? outcome.timing === "lt24h"
        ? "Canceled under 24h. The class is deducted from the package."
        : "Canceled. You can reschedule your class."
      : outcome.timing === "lt24h"
        ? "Cancelaste con menos de 24h. La clase se descuenta del paquete."
        : "Cancelada. Puedes reagendar tu clase.",
  };
}

const teacherCancelSchema = z.object({
  bookingId: z.string().uuid(),
  reason: z.string().trim().min(3, "Da una razón breve.").max(500),
});

export async function cancelBookingAsTeacher(
  _prev: CancelState,
  formData: FormData,
): Promise<CancelState> {
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = teacherCancelSchema.safeParse({
    bookingId: formData.get("bookingId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
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
    return { error: en ? "We couldn't find that class." : "No encontramos esa clase." };
  }
  if (outcome.code === "wrong-status") {
    return {
      error: en
        ? "This class is already off the calendar."
        : "Esta clase ya está fuera del calendario.",
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
    ok: en
      ? "Class canceled and restored to the student's package."
      : "Clase cancelada y restaurada al paquete del alumno.",
  };
}
