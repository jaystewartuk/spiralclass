"use server";

import { getAuthUser, requireOnboardedTeacher } from "@/lib/auth";
import { acceptInvitation } from "@/lib/invitations/accept";
import { getPreferredLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { bulkInviteSchema, invitationActionSchema, singleInviteSchema } from "@/lib/validators";
import { classifyForTeacher, collectInvitees, sendInvitations } from "@/lib/invitations/service";
import {
  cancelInvitation,
  markInvitationSent,
  rotateInvitationForResend,
} from "@/lib/invitations/manage";
import {
  sendInvitationEmail,
  invitationAcceptUrl,
  invitationEmailLocale,
} from "@/lib/invitations/send";
import { teacherPhotoPublicUrl } from "@/lib/storage/teacher-photo";
import { messagingBenefitEnabled } from "@/lib/invitations/service";
import type { InviteeDisposition } from "@/lib/invitations/bulk";
import { revalidateAfterAction } from "@/lib/revalidate";
import { usesEnglishCopy } from "@spiralclass/shared";

// Server actions for the teacher-facing invitation flow. Every action is
// teacher-scoped (requireOnboardedTeacher gates + scopes) and audited via the
// PostHog funnel events. Copy is localized with getPreferredLocale.

const DASH = "/dashboard/students/invitations";

export type InvitePreviewRow = {
  email: string;
  name: string | null;
  disposition: InviteeDisposition;
};

export type InviteFormState =
  | {
      error?: string;
      ok?: string;
      // Confirmation-screen data (from previewInvitesAction).
      preview?: {
        rows: InvitePreviewRow[];
        sendableCount: number;
        invalidCount: number;
        truncated: boolean;
      };
      // Result summary (from sendInvitesAction).
      sentCount?: number;
    }
  | undefined;

// Preview: parse + classify, no writes. Powers the "confirmation screen before
// sending" the spec requires.
export async function previewInvitesAction(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const teacher = await requireOnboardedTeacher();

  const parsed = bulkInviteSchema(locale).safeParse({
    list: formData.get("list") ?? undefined,
    studentIds: parseStudentIds(formData.get("studentIds")),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
    };
  }

  const collected = await collectInvitees(teacher.id, parsed.data);
  if (collected.entries.length === 0) {
    return {
      error: en ? "No valid emails found." : "No se encontraron correos válidos.",
    };
  }
  const classified = await classifyForTeacher(teacher.id, collected.entries);
  return {
    preview: {
      rows: classified.classified.map((c) => ({
        email: c.email,
        name: c.name,
        disposition: c.disposition,
      })),
      sendableCount: classified.sendable.length,
      invalidCount: collected.issues.length,
      truncated: collected.truncated,
    },
  };
}

// Send: re-parse, re-classify, provision + email the sendable set.
export async function sendInvitesAction(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const teacher = await requireOnboardedTeacher();

  const parsed = bulkInviteSchema(locale).safeParse({
    list: formData.get("list") ?? undefined,
    studentIds: parseStudentIds(formData.get("studentIds")),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
    };
  }
  const source = (formData.get("source") === "single" ? "single" : "bulk") as "single" | "bulk";

  const collected = await collectInvitees(teacher.id, parsed.data);
  const classified = await classifyForTeacher(teacher.id, collected.entries);
  if (classified.sendable.length === 0) {
    return {
      error: en
        ? "Nothing to send — those students are already connected or invited."
        : "Nada que enviar — esos alumnos ya están conectados o invitados.",
    };
  }

  const { summary, results } = await sendInvitations(teacher, classified.sendable);

  for (const r of results) {
    trackServerEvent({
      name: "invitation_created",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id, invitationId: r.invitationId, source },
    });
    trackServerEvent({
      name: "invitation_sent",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id, invitationId: r.invitationId, source },
    });
  }
  if (source === "bulk") {
    trackServerEvent({
      name: "invitation_bulk_completed",
      distinctId: teacher.id,
      properties: {
        teacherId: teacher.id,
        requested: collected.entries.length,
        sent: summary.sent,
        skippedDuplicate: classified.counts.duplicate_in_list + classified.counts.already_invited,
        skippedConnected: classified.counts.already_connected,
        skippedInvalid: collected.issues.length,
      },
    });
  }
  await flushAnalytics();
  revalidateAfterAction(DASH);

  const failedNote =
    summary.failed > 0
      ? en
        ? ` (${summary.failed} couldn't be delivered)`
        : ` (${summary.failed} no se pudieron enviar)`
      : "";
  return {
    sentCount: summary.sent,
    ok: en
      ? `Sent ${summary.sent} invitation${summary.sent === 1 ? "" : "s"}.${failedNote}`
      : `Se ${summary.sent === 1 ? "envió" : "enviaron"} ${summary.sent} invitación${summary.sent === 1 ? "" : "es"}.${failedNote}`,
  };
}

// Single invite convenience — same pipeline, one email. Kept separate so the
// single-add form can post {email,name} directly.
export async function inviteSingleAction(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = singleInviteSchema(locale).safeParse({
    email: formData.get("email"),
    name: formData.get("name") ?? undefined,
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
    };
  }
  const forwarded = new FormData();
  forwarded.set(
    "list",
    parsed.data.name ? `${parsed.data.name}, ${parsed.data.email}` : parsed.data.email,
  );
  forwarded.set("source", "single");
  return sendInvitesAction(undefined, forwarded);
}

export type RosterActionState = { error?: string; ok?: string; url?: string } | undefined;

export async function resendInvitationAction(
  _prev: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = invitationActionSchema.safeParse({ invitationId: formData.get("invitationId") });
  if (!parsed.success) return { error: en ? "Invalid data." : "Datos inválidos." };

  const teacher = await requireOnboardedTeacher();
  const rotated = await rotateInvitationForResend(teacher.id, parsed.data.invitationId);
  if (rotated.status === "not_found") {
    return { error: en ? "Invitation not found." : "Invitación no encontrada." };
  }
  if (rotated.status === "not_pending") {
    return {
      error: en
        ? "That invitation was already accepted or cancelled."
        : "Esa invitación ya fue aceptada o cancelada.",
    };
  }

  try {
    await sendInvitationEmail({
      to: rotated.invitation.email,
      teacherName: teacher.name,
      studentName: rotated.invitation.name,
      rawToken: rotated.rawToken,
      locale: invitationEmailLocale(rotated.studentLocale, teacher.locale),
      teacherAvatarUrl: teacherPhotoPublicUrl(teacher.photoPath, teacher.updatedAt.getTime()),
      messagingEnabled: messagingBenefitEnabled(),
    });
    await markInvitationSent(rotated.invitation.id, { resend: true });
  } catch {
    return {
      error: en
        ? "Couldn't send the invitation email."
        : "No se pudo enviar el correo de invitación.",
    };
  }

  trackServerEvent({
    name: "invitation_resent",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, invitationId: rotated.invitation.id },
  });
  await flushAnalytics();
  revalidateAfterAction(DASH);
  return { ok: en ? "Invitation resent." : "Invitación reenviada." };
}

export async function cancelInvitationAction(
  _prev: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = invitationActionSchema.safeParse({ invitationId: formData.get("invitationId") });
  if (!parsed.success) return { error: en ? "Invalid data." : "Datos inválidos." };

  const teacher = await requireOnboardedTeacher();
  const result = await cancelInvitation(teacher.id, parsed.data.invitationId);
  if (result.status === "not_found") {
    return { error: en ? "Invitation not found." : "Invitación no encontrada." };
  }
  if (result.status === "already_accepted") {
    return {
      error: en ? "That student already accepted." : "Ese alumno ya aceptó.",
    };
  }
  trackServerEvent({
    name: "invitation_cancelled",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, invitationId: parsed.data.invitationId },
  });
  await flushAnalytics();
  revalidateAfterAction(DASH);
  return { ok: en ? "Invitation cancelled." : "Invitación cancelada." };
}

// Copy link — rotates the token so the copied URL is always the current valid
// one (the previous hash is overwritten, invalidating any older link). Returns
// the absolute accept URL for the client to copy.
export async function copyInvitationLinkAction(
  _prev: RosterActionState,
  formData: FormData,
): Promise<RosterActionState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = invitationActionSchema.safeParse({ invitationId: formData.get("invitationId") });
  if (!parsed.success) return { error: en ? "Invalid data." : "Datos inválidos." };

  const teacher = await requireOnboardedTeacher();
  const rotated = await rotateInvitationForResend(teacher.id, parsed.data.invitationId);
  if (rotated.status !== "ok") {
    return { error: en ? "Invitation not found." : "Invitación no encontrada." };
  }
  return { url: invitationAcceptUrl(rotated.rawToken), ok: en ? "Link ready." : "Enlace listo." };
}

// The multi-select-existing-students entry: invite every rostered student with
// no login and no live invitation, in one go.
export async function inviteRosterStudentsAction(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const ids = parseStudentIds(formData.get("studentIds"));
  const forwarded = new FormData();
  forwarded.set("studentIds", JSON.stringify(ids));
  forwarded.set("source", "bulk");
  return sendInvitesAction(undefined, forwarded);
}

// --- Student-side acceptance -------------------------------------------------

export type AcceptActionState =
  | {
      status:
        | "accepted"
        | "invalid"
        | "expired"
        | "cancelled"
        | "email_mismatch"
        | "is_teacher"
        | "accepted_by_other"
        | "needs_auth";
      redirect?: string;
      invitedEmail?: string;
    }
  | undefined;

// Accept an invitation as the currently-authenticated user. Idempotent (see
// lib/invitations/accept). Emits the student-side funnel events. The client
// navigates to `redirect` on success.
export async function acceptInvitationAction(
  _prev: AcceptActionState,
  formData: FormData,
): Promise<AcceptActionState> {
  const token = typeof formData.get("token") === "string" ? (formData.get("token") as string) : "";
  const user = await getAuthUser();
  if (!user) return { status: "needs_auth" };

  const result = await acceptInvitation({
    rawToken: token,
    user: { id: user.id, email: user.email },
  });
  if (result.status !== "accepted") {
    return {
      status: result.status,
      invitedEmail: result.status === "email_mismatch" ? result.invitedEmail : undefined,
    };
  }

  if (!result.alreadyAccepted) {
    // Time-to-acceptance: minutes from the (first) send to now.
    const inv = await prisma.studentInvitation.findUnique({
      where: { id: (await latestInvitationIdForAccept(result.teacherId, result.studentId)) ?? "" },
      select: { sentAt: true },
    });
    const minutesToAccept = inv?.sentAt
      ? Math.max(0, Math.round((Date.now() - inv.sentAt.getTime()) / 60000))
      : undefined;
    trackServerEvent({
      name: result.existingAccount ? "invitation_existing_account_linked" : "invitation_accepted",
      distinctId: result.linkedStudentId,
      properties: {
        teacherId: result.teacherId,
        invitationId: result.studentId,
        studentId: result.linkedStudentId,
        channel: "web",
        minutesToAccept,
      },
    });
    await flushAnalytics();
  }
  return { status: "accepted", redirect: "/my-classes" };
}

// The teacher's roster row → its accepted invitation id, for the analytics
// lookup above. Small helper kept local to the action.
async function latestInvitationIdForAccept(
  teacherId: string,
  studentId: string,
): Promise<string | null> {
  const inv = await prisma.studentInvitation.findFirst({
    where: { teacherId, studentId, status: "accepted" },
    orderBy: { acceptedAt: "desc" },
    select: { id: true },
  });
  return inv?.id ?? null;
}

function parseStudentIds(raw: FormDataEntryValue | null): string[] | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // Comma-separated fallback.
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return undefined;
}
