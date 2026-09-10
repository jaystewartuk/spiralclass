"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { writeOverride } from "@/lib/audit";
import { auth } from "@/lib/auth/server";
import { getPreferredLocale } from "@/lib/i18n";
import { enqueueAccountDisabledTeacher } from "@/lib/notifications/enqueue";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { logger } from "@/lib/logger";
import { revalidateAfterAction } from "@/lib/revalidate";
import { usesEnglishCopy } from "@spiralclass/shared";

const log = logger({ surface: "admin-teachers" });

export type AdminTeacherActionState = { error?: string; ok?: boolean; info?: string } | undefined;

const disableSchema = z.object({
  teacherId: z.string().uuid("ID inválido"),
  reason: z.string().trim().min(1, "Motivo requerido").max(280),
});

const enableSchema = z.object({
  teacherId: z.string().uuid("ID inválido"),
});

const resendSchema = z.object({
  teacherId: z.string().uuid("ID inválido"),
});

export async function disableTeacherAction(
  _prev: AdminTeacherActionState,
  formData: FormData,
): Promise<AdminTeacherActionState> {
  const actor = await requireAdmin("support");
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = disableSchema.safeParse({
    teacherId: formData.get("teacherId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos"),
    };
  }

  const notificationId = await prisma.$transaction(async (tx) => {
    const before = await tx.teacher.findUnique({
      where: { id: parsed.data.teacherId },
      select: { disabledAt: true, disabledReason: true },
    });
    await tx.teacher.update({
      where: { id: parsed.data.teacherId },
      data: { disabledAt: new Date(), disabledReason: parsed.data.reason },
    });
    await writeOverride({
      tx,
      teacherId: parsed.data.teacherId,
      targetType: "teacher",
      targetId: parsed.data.teacherId,
      action: "disable_teacher",
      reason: parsed.data.reason,
      before: { disabledAt: before?.disabledAt?.toISOString() ?? null },
      after: { disabledAt: new Date().toISOString() },
      actor,
    });
    return enqueueAccountDisabledTeacher(tx, { teacherId: parsed.data.teacherId });
  });

  try {
    await emitNotificationQueued({
      notificationId,
      teacherId: parsed.data.teacherId,
    });
  } catch (err) {
    log.warn("emit notification.queued failed", { error: err });
  }

  revalidateAfterAction(`/admin/teachers/${parsed.data.teacherId}`);
  return { ok: true };
}

export async function enableTeacherAction(
  _prev: AdminTeacherActionState,
  formData: FormData,
): Promise<AdminTeacherActionState> {
  const actor = await requireAdmin("support");
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = enableSchema.safeParse({
    teacherId: formData.get("teacherId"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos"),
    };
  }

  await prisma.$transaction(async (tx) => {
    const before = await tx.teacher.findUnique({
      where: { id: parsed.data.teacherId },
      select: { disabledAt: true, disabledReason: true },
    });
    await tx.teacher.update({
      where: { id: parsed.data.teacherId },
      data: { disabledAt: null, disabledReason: null },
    });
    await writeOverride({
      tx,
      teacherId: parsed.data.teacherId,
      targetType: "teacher",
      targetId: parsed.data.teacherId,
      action: "enable_teacher",
      reason: before?.disabledReason ?? "(no previous reason)",
      before: { disabledAt: before?.disabledAt?.toISOString() ?? null },
      after: { disabledAt: null },
      actor,
    });
  });

  revalidateAfterAction(`/admin/teachers/${parsed.data.teacherId}`);
  return { ok: true };
}

// Resend a passwordless sign-in code to a teacher from the admin panel
// (e.g. "Alicia Moreno didn't receive her sign-in email"). Sends the same
// email-OTP code the public sign-in flow uses; no rate-limit (admin is the
// gate).
export async function resendTeacherMagicLinkAction(
  _prev: AdminTeacherActionState,
  formData: FormData,
): Promise<AdminTeacherActionState> {
  await requireAdmin("support");
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = resendSchema.safeParse({
    teacherId: formData.get("teacherId"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos"),
    };
  }

  const teacher = await prisma.teacher.findUnique({
    where: { id: parsed.data.teacherId },
    select: { email: true },
  });
  if (!teacher) return { error: en ? "Teacher not found" : "Maestra no encontrada" };

  try {
    await auth.api.sendVerificationOTP({
      body: { email: teacher.email, type: "sign-in" },
      headers: await headers(),
    });
  } catch {
    return { error: en ? "Couldn't send the email" : "No se pudo enviar el correo" };
  }

  return {
    ok: true,
    info: en ? `Email sent to ${teacher.email}` : `Correo enviado a ${teacher.email}`,
  };
}
