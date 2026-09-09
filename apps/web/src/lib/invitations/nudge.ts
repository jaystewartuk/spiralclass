import type { PrismaClient } from "@prisma/client";
import { serverEnv } from "@/lib/env";
import { getEmailClient } from "@/lib/email";
import { renderBrandedEmailHtml } from "@/lib/email/html-shell";
import { logger } from "@/lib/logger";
import { SUPPORT_EMAIL } from "@/lib/support";
import { localeToLanguageCode } from "@spiralclass/shared";
import { INVITATION_NUDGE_AFTER_DAYS } from "./constants";

const log = logger({ surface: "invitations" });

// Pending-invite teacher reminder (D-83). A daily cron collects every teacher
// who has invitations that were sent ≥ N days ago, are still pending, still
// unexpired, and haven't been nudged, then emails the teacher ONE digest per
// run naming how many students haven't accepted — with a link back to the
// invitation dashboard where she can resend. Idempotent: each invitation's
// reminderSentAt is stamped so it never re-nudges (a resend re-arms it).
//
// Standalone (not routed through the notification dispatcher) because the
// recipient context is simple and this keeps the change off the Tier-2
// dispatcher exhaustiveness surface. Suppressed for archived pairings is N/A —
// the recipient is the teacher, addressed about her own outstanding invites.

export async function sendPendingInviteNudges(deps: {
  prisma: PrismaClient;
  now?: Date;
}): Promise<{ teachersNudged: number; invitationsCovered: number }> {
  const prisma = deps.prisma;
  const now = deps.now ?? new Date();
  const cutoff = new Date(now.getTime() - INVITATION_NUDGE_AFTER_DAYS * 24 * 60 * 60 * 1000);

  // Candidate invitations: pending, sent long enough ago, not yet expired, not
  // yet nudged. Group by teacher in memory (volumes are small).
  const candidates = await prisma.studentInvitation.findMany({
    where: {
      status: "pending",
      reminderSentAt: null,
      sentAt: { not: null, lte: cutoff },
      expiresAt: { gt: now },
    },
    select: { id: true, teacherId: true },
  });
  if (candidates.length === 0) return { teachersNudged: 0, invitationsCovered: 0 };

  const byTeacher = new Map<string, string[]>();
  for (const c of candidates) {
    const list = byTeacher.get(c.teacherId) ?? [];
    list.push(c.id);
    byTeacher.set(c.teacherId, list);
  }

  const appUrl = serverEnv().APP_URL.replace(/\/$/, "");
  let teachersNudged = 0;
  let invitationsCovered = 0;

  for (const [teacherId, invitationIds] of byTeacher) {
    const teacher = await prisma.teacher.findUnique({
      where: { id: teacherId },
      select: { name: true, email: true, locale: true, disabledAt: true },
    });
    if (!teacher || teacher.disabledAt || !teacher.email) continue;

    const count = invitationIds.length;
    const languageCode = localeToLanguageCode(teacher.locale);
    const es = languageCode === "es_MX";
    const dashUrl = `${appUrl}/dashboard/students/invitations`;

    const subject = es
      ? `${count} ${count === 1 ? "alumno no ha" : "alumnos no han"} aceptado tu invitación`
      : `${count} student${count === 1 ? " hasn't" : "s haven't"} accepted your invitation`;
    const heading = es ? "Invitaciones pendientes" : "Pending invitations";
    const intro = es
      ? `Hola ${teacher.name}, ${count === 1 ? "un alumno" : `${count} alumnos`} que invitaste aún no ${count === 1 ? "acepta" : "aceptan"} su invitación. Puedes reenviarla en un toque desde tu panel.`
      : `Hi ${teacher.name}, ${count === 1 ? "a student" : `${count} students`} you invited ${count === 1 ? "hasn't" : "haven't"} accepted yet. You can resend in one tap from your dashboard.`;
    const cta = { label: es ? "Ver invitaciones" : "View invitations", url: dashUrl };

    const html = renderBrandedEmailHtml(
      { preheader: subject, heading, paragraphs: [intro], cta },
      { languageCode, appUrl },
    );
    const body = `${intro}\n\n${cta.label}: ${dashUrl}`;

    try {
      const res = await getEmailClient().send({
        to: teacher.email,
        subject,
        body,
        html,
        replyTo: SUPPORT_EMAIL,
      });
      if (!res.ok) {
        log.warn("pending-invite nudge send failed", { teacherId, error: res.error });
        continue;
      }
    } catch (err) {
      log.warn("pending-invite nudge threw", { teacherId, error: String(err) });
      continue;
    }

    // Stamp only after a successful send so a failed send retries next run.
    await prisma.studentInvitation.updateMany({
      where: { id: { in: invitationIds }, status: "pending", reminderSentAt: null },
      data: { reminderSentAt: now },
    });
    teachersNudged += 1;
    invitationsCovered += count;
  }

  return { teachersNudged, invitationsCovered };
}
