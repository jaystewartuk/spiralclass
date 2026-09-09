"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { writeOverride } from "@/lib/audit";
import { getPreferredLocale } from "@/lib/i18n";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { getEmailClient } from "@/lib/email";

export type AdminNotificationActionState =
  { error?: string; ok?: boolean; info?: string } | undefined;

const retrySchema = z.object({
  notificationId: z.string().uuid("ID inválido"),
});

// Resets a failed/stale notification to `queued` and re-emits the
// dispatcher event. The dispatcher is idempotent — if it's already
// queued or sent, it noops. Use when a transient provider failure
// left a notification in `failed` and the underlying condition is
// fixed (e.g. Resend creds added, push tokens registered).
export async function retryNotificationAction(
  _prev: AdminNotificationActionState,
  formData: FormData,
): Promise<AdminNotificationActionState> {
  await requireAdmin("support");
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = retrySchema.safeParse({
    notificationId: formData.get("notificationId"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos"),
    };
  }

  const existing = await prisma.notification.findUnique({
    where: { id: parsed.data.notificationId },
    select: { id: true, status: true, teacherId: true },
  });
  if (!existing) return { error: en ? "Notification not found" : "Notificación no encontrada" };
  if (existing.status === "sent" || existing.status === "delivered") {
    return {
      error: en
        ? `Already in "${existing.status}" state`
        : `Ya está en estado "${existing.status}"`,
    };
  }

  await prisma.notification.update({
    where: { id: existing.id },
    data: {
      status: "queued",
      error: null,
      failedAt: null,
    },
  });
  await emitNotificationQueued({
    notificationId: existing.id,
    teacherId: existing.teacherId,
  });

  revalidatePath("/admin/notifications");
  return { ok: true, info: en ? "Re-queued" : "Re-encolado" };
}

const broadcastSchema = z.object({
  audience: z.enum(["teachers", "students-active"]),
  subject: z.string().trim().min(1, "Asunto requerido").max(150),
  body: z.string().trim().min(1, "Cuerpo requerido").max(5000),
});

// Ad-hoc admin broadcast email. Bypasses the queued-notification
// pipeline (which only knows the known transactional templates) and
// hits the Resend client directly. Each recipient is sent as its own
// email — no BCC — so a bounce on one doesn't take down the batch.
//
// Audiences (kept narrow on purpose):
//   * teachers           → all non-disabled teachers
//   * students-active    → students with at least one active package
//                          and email-opt-in=true
//
// Writes a single audit row (no per-recipient row, that would be
// noisy). Each individual delivery is best-effort: the action
// returns success once enqueued, even if a subset fails. Use the
// Resend dashboard for delivery diagnostics.
export async function sendAdminBroadcastAction(
  _prev: AdminNotificationActionState,
  formData: FormData,
): Promise<AdminNotificationActionState> {
  const actor = await requireAdmin("superadmin");
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = broadcastSchema.safeParse({
    audience: formData.get("audience"),
    subject: formData.get("subject"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos"),
    };
  }

  let recipients: { email: string }[] = [];
  if (parsed.data.audience === "teachers") {
    recipients = await prisma.teacher.findMany({
      where: { disabledAt: null },
      select: { email: true },
    });
  } else {
    const rows = await prisma.student.findMany({
      where: {
        disabledAt: null,
        emailOptIn: true,
        email: { not: null },
        packages: { some: { status: "active" } },
      },
      select: { email: true },
    });
    recipients = rows.filter((r): r is { email: string } => Boolean(r.email));
  }

  if (recipients.length === 0) return { error: en ? "No recipients" : "No hay destinatarios" };

  const email = getEmailClient();
  let sent = 0;
  let failed = 0;
  for (const r of recipients) {
    const res = await email.send({
      to: r.email,
      subject: parsed.data.subject,
      body: parsed.data.body,
    });
    if (res.ok) sent++;
    else failed++;
  }

  // `overrides` is a per-teacher audit table — `teacherId` is a real FK — and
  // this action is platform-wide, so there is no correct tenant to scope the
  // row to. It is attributed to an arbitrary teacher rather than dropped,
  // because an unattributed audit row is worth more than no audit row.
  //
  // A pointer here used to defer the explanation to a note in `writeOverride`.
  // There is no such note in `lib/audit.ts`, so the reasoning is written out
  // above instead of deferred to a file that never carried it.
  const auditTeacher = await prisma.teacher.findFirst({ select: { id: true } });
  if (auditTeacher) {
    await writeOverride({
      teacherId: auditTeacher.id,
      targetType: "teacher",
      targetId: auditTeacher.id,
      action: "broadcast",
      reason: `${parsed.data.audience} · ${parsed.data.subject}`,
      after: { audience: parsed.data.audience, sent, failed, recipients: recipients.length },
      actor,
    });
  }

  revalidatePath("/admin/notifications");
  return {
    ok: true,
    info: en
      ? `Sent: ${sent}/${recipients.length}${failed ? ` · ${failed} failed` : ""}`
      : `Enviados: ${sent}/${recipients.length}${failed ? ` · ${failed} fallaron` : ""}`,
  };
}
