import { Prisma, type PrismaClient, type StudentInvitation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { INVITATION_TTL_DAYS } from "./constants";
import { generateInvitationToken, hashInvitationToken } from "./token";
import { isTerminalStatus } from "./status";
import { defaultNewStudentNotificationPrefs } from "@/lib/notifications/preferences";

// Core invitation lifecycle: provision (create-or-reuse the roster student +
// mint a pending invitation), resend, cancel. All teacher-scoped (tenant isolation) and
// built on the same advisory-lock discipline the checkout upsert uses, since
// students.email is deliberately non-unique.

type Db = PrismaClient | Prisma.TransactionClient;

export type ProvisionInvitationInput = {
  teacherId: string;
  email: string; // already normalized (trim + lowercase)
  name: string | null;
  // Locale for the new roster student when one is created. Omitted → the
  // column default ("en") applies. Ignored when a student row already exists.
  locale?: string;
};

export type ProvisionInvitationResult =
  | {
      status: "created";
      invitation: StudentInvitation;
      // Raw token — returned ONCE, only here; it's never persisted or re-derivable.
      rawToken: string;
      studentId: string;
      // The roster row's own locale — what the invitation email renders in.
      // See invitationEmailLocale() in ./send.
      studentLocale: string | null;
      createdStudent: boolean;
    }
  // The email already belongs to a Teacher account — Teacher/Student are
  // mutually exclusive, so we refuse rather than mint an unsignable roster row.
  | { status: "teacher_conflict" }
  // A roster student with this email already has a login on this teacher — no
  // invitation needed.
  | { status: "already_connected"; studentId: string }
  // A live (pending, unexpired) invitation already exists — the caller resends
  // it rather than minting a duplicate.
  | { status: "already_pending"; invitation: StudentInvitation };

function expiryFrom(now: Date): Date {
  return new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

// Provision a single invitation. Serialized per (teacher, email) by a
// transaction-scoped advisory lock so two concurrent invites (or a
// double-submit) can't fork two roster rows or two pending invitations.
export async function provisionInvitation(
  input: ProvisionInvitationInput,
  db: PrismaClient = prisma,
): Promise<ProvisionInvitationResult> {
  const email = input.email;
  const now = new Date();

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`invite:${input.teacherId}:${email}`}, 0))`;

    // Teacher/Student mutual exclusivity — same guard as find-or-create.
    const teacherConflict = await tx.teacher.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    if (teacherConflict) return { status: "teacher_conflict" } as const;

    // Find (or create) the roster student for this (teacher, email).
    const existingStudent = await tx.student.findFirst({
      where: {
        email,
        teacherStudents: { some: { teacherId: input.teacherId } },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, authUserId: true, locale: true },
    });

    let studentId: string;
    let studentLocale: string | null;
    let createdStudent = false;
    if (existingStudent) {
      if (existingStudent.authUserId) {
        return { status: "already_connected", studentId: existingStudent.id } as const;
      }
      studentId = existingStudent.id;
      studentLocale = existingStudent.locale;
    } else {
      const created = await tx.student.create({
        data: {
          name: input.name?.trim() || email,
          email,
          // Omitted when the caller has no locale → the column default ("en")
          // applies, rather than the es-MX this used to hardcode.
          ...(input.locale ? { locale: input.locale } : {}),
          notificationPrefs: defaultNewStudentNotificationPrefs(),
          // Staged silently until the student accepts — the invitation IS the
          // introduction, so no lifecycle notifications fire meanwhile (the
          // acceptance clears the hold).
          teacherStudents: { create: { teacherId: input.teacherId, onboardingHoldAt: now } },
        },
        select: { id: true, locale: true },
      });
      studentId = created.id;
      studentLocale = created.locale;
      createdStudent = true;
    }

    // An outstanding pending invitation? (Terminal rows accumulate as history.)
    const pending = await tx.studentInvitation.findFirst({
      where: { teacherId: input.teacherId, email, status: "pending" },
    });
    if (pending) return { status: "already_pending", invitation: pending } as const;

    const rawToken = generateInvitationToken();
    const invitation = await tx.studentInvitation.create({
      data: {
        teacherId: input.teacherId,
        studentId,
        email,
        name: input.name?.trim() || null,
        tokenHash: hashInvitationToken(rawToken),
        status: "pending",
        expiresAt: expiryFrom(now),
      },
    });
    return {
      status: "created",
      invitation,
      rawToken,
      studentId,
      studentLocale,
      createdStudent,
    } as const;
  });
}

// Mark an invitation as delivered (first send or resend). Bumps lastSentAt +
// resendCount; stamps sentAt on the first send. Called after the email
// provider confirms the send so a pending row always reflects a real delivery.
export async function markInvitationSent(
  invitationId: string,
  opts: { resend: boolean } = { resend: false },
  db: Db = prisma,
): Promise<void> {
  const now = new Date();
  await db.studentInvitation.update({
    where: { id: invitationId },
    data: {
      lastSentAt: now,
      ...(opts.resend ? { resendCount: { increment: 1 } } : { sentAt: now }),
    },
  });
}

// Roll back a pending invitation whose delivery failed, so it doesn't linger as
// a "pending" row that was never actually emailed (and so the partial unique
// slot frees for a retry). Only deletes a still-pending, never-sent row.
export async function discardUnsentInvitation(
  invitationId: string,
  db: Db = prisma,
): Promise<void> {
  await db.studentInvitation.deleteMany({
    where: { id: invitationId, status: "pending", sentAt: null },
  });
}

export type ResendResult =
  | {
      status: "ok";
      invitation: StudentInvitation;
      rawToken: string;
      // The roster row's own locale, so a resend renders in the same language
      // the first send did. See invitationEmailLocale() in ./send.
      studentLocale: string | null;
    }
  | { status: "not_found" }
  | { status: "not_pending" };

// Resend re-mints a fresh token (invalidating any older link — the previous
// hash is overwritten) and pushes the expiry window out, so a resent invite is
// always freshly valid. The caller then sends the email + markInvitationSent.
export async function rotateInvitationForResend(
  teacherId: string,
  invitationId: string,
  db: PrismaClient = prisma,
): Promise<ResendResult> {
  const now = new Date();
  return db.$transaction(async (tx) => {
    const invitation = await tx.studentInvitation.findFirst({
      where: { id: invitationId, teacherId },
      include: { student: { select: { locale: true } } },
    });
    if (!invitation) return { status: "not_found" } as const;
    if (isTerminalStatus(invitation.status)) return { status: "not_pending" } as const;

    const rawToken = generateInvitationToken();
    const updated = await tx.studentInvitation.update({
      where: { id: invitation.id },
      // Re-open expiry and clear any derived-expired state back to pending.
      data: {
        tokenHash: hashInvitationToken(rawToken),
        status: "pending",
        expiresAt: expiryFrom(now),
        // Re-arm the pending nudge — a resent invite can nudge the teacher again.
        reminderSentAt: null,
      },
    });
    return {
      status: "ok",
      invitation: updated,
      rawToken,
      studentLocale: invitation.student.locale,
    } as const;
  });
}

export type CancelResult =
  { status: "ok" } | { status: "not_found" } | { status: "already_accepted" };

// Revoke a pending invitation. Idempotent for an already-cancelled row (still
// "ok"); refuses to cancel one that's already accepted (that's a linked
// account now, not a pending invite). Cancelling invalidates the token: accept
// checks status, so the link stops working immediately.
export async function cancelInvitation(
  teacherId: string,
  invitationId: string,
  db: PrismaClient = prisma,
): Promise<CancelResult> {
  const invitation = await db.studentInvitation.findFirst({
    where: { id: invitationId, teacherId },
    select: { id: true, status: true },
  });
  if (!invitation) return { status: "not_found" };
  if (invitation.status === "accepted") return { status: "already_accepted" };
  if (invitation.status === "cancelled") return { status: "ok" };
  await db.studentInvitation.update({
    where: { id: invitation.id },
    data: { status: "cancelled", cancelledAt: new Date() },
  });
  return { status: "ok" };
}
