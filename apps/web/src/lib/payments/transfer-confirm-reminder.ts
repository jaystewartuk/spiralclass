import type { PrismaClient } from "@prisma/client";
import { enqueueWiseConfirmReminderTeacher } from "@/lib/notifications/enqueue";
import { emitNotificationQueued } from "@/lib/notifications/events";

// Pure handler for the Wise confirm-reminder cron. Finds Wise payments the
// student marked sent ≥ `staleHours` ago that the teacher still hasn't
// confirmed, and re-pings the teacher — money sitting unactivated due to
// forgetfulness. One reminder per payment, ever (dedup on the existing
// notifications.paymentId), so the cron is safe to run frequently.

const HOUR_MS = 60 * 60 * 1000;

export type TransferReminderDeps = {
  prisma: PrismaClient;
  emit?: (input: { notificationId: string; teacherId: string }) => Promise<void>;
  // How long after the student marked-sent before we nudge the teacher.
  staleHours?: number;
  now?: Date;
};

export async function sendTransferConfirmReminders(
  deps: TransferReminderDeps,
): Promise<{ ok: true; sent: number; skipped: number }> {
  const { prisma } = deps;
  const emit = deps.emit ?? emitNotificationQueued;
  const now = deps.now ?? new Date();
  const cutoff = new Date(now.getTime() - (deps.staleHours ?? 24) * HOUR_MS);

  // Wise payments still pending, marked sent by the student long enough ago,
  // and never confirmed (teacher- or auto-).
  const stuck = await prisma.payment.findMany({
    where: {
      provider: "manual_transfer",
      status: "pending",
      studentMarkedSentAt: { not: null, lte: cutoff },
      confirmedAt: null,
    },
    select: {
      id: true,
      package: { select: { teacherId: true } },
    },
  });
  if (stuck.length === 0) return { ok: true, sent: 0, skipped: 0 };

  // Dedup: skip payments already reminded (notifications carry paymentId).
  const prior = await prisma.notification.findMany({
    where: {
      templateName: "wise_confirm_reminder_teacher",
      paymentId: { in: stuck.map((p) => p.id) },
    },
    select: { paymentId: true },
  });
  const reminded = new Set(prior.map((n) => n.paymentId));

  let sent = 0;
  let skipped = 0;
  for (const payment of stuck) {
    if (reminded.has(payment.id)) {
      skipped += 1;
      continue;
    }
    const teacherId = payment.package.teacherId;
    const notificationId = await enqueueWiseConfirmReminderTeacher(prisma, {
      teacherId,
      paymentId: payment.id,
    });
    await emit({ notificationId, teacherId });
    sent += 1;
  }

  return { ok: true, sent, skipped };
}
