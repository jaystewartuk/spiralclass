import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveLinkedStudent } from "@/lib/auth/student-link";
import { effectiveInvitationStatus } from "./status";
import { hashInvitationToken, isWellFormedInvitationToken } from "./token";

// Acceptance of an invitation by an AUTHENTICATED user. Idempotent, and the
// security choke point of the whole flow. Given a raw token + the signed-in
// user, it verifies the token, enforces that the accepting inbox matches the
// invited inbox, links the account, clears the teacher's onboarding hold, and
// marks the invitation accepted.
//
// Linking is DELEGATED to resolveLinkedStudent (not a direct authUserId write)
// so it honours the one-login-binds-the-oldest-rostered-row invariant and the
// multi-teacher identity set — see lib/auth/student-link.ts. Since the invited
// student row shares the invited email, resolveLinkedStudent claims the right
// row; this teacher's specific pairing then has its hold cleared regardless of
// which sibling row won the link.

export type AcceptResult =
  // Success (also the idempotent re-accept path). studentId is THIS teacher's
  // roster row from the invitation; linkedStudentId is the row the login binds.
  // `existingAccount` is true when the accepting identity already had a
  // linked Student row before this acceptance (picking up a new teacher's
  // roster row on an existing login) — callers use it to fire
  // `invitation_existing_account_linked` instead of `invitation_accepted`.
  // Meaningless (and always false) when `alreadyAccepted` is true, since
  // callers skip firing an event on the idempotent re-accept path.
  | {
      status: "accepted";
      teacherId: string;
      studentId: string;
      linkedStudentId: string;
      alreadyAccepted: boolean;
      existingAccount: boolean;
    }
  | { status: "invalid" } // token malformed / unknown
  | { status: "expired" }
  | { status: "cancelled" }
  // Signed-in inbox differs from the invited inbox — refuse (hijack guard).
  | { status: "email_mismatch"; invitedEmail: string }
  // The signed-in identity owns a Teacher account — Teacher/Student are
  // mutually exclusive, so it can't accept a student invitation.
  | { status: "is_teacher" }
  // Accepted previously by a DIFFERENT identity (a linked account already).
  | { status: "accepted_by_other" };

export async function acceptInvitation(
  input: { rawToken: string; user: { id: string; email?: string | null } },
  db: PrismaClient = prisma,
): Promise<AcceptResult> {
  if (!isWellFormedInvitationToken(input.rawToken)) return { status: "invalid" };
  const tokenHash = hashInvitationToken(input.rawToken);

  const invitation = await db.studentInvitation.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      teacherId: true,
      studentId: true,
      email: true,
      status: true,
      expiresAt: true,
      acceptedByUserId: true,
    },
  });
  if (!invitation) return { status: "invalid" };

  const userEmail = input.user.email?.trim().toLowerCase() ?? null;
  const invitedEmail = invitation.email.toLowerCase();

  // Already-accepted handling first, so re-clicking a used link is idempotent
  // for the same person and a hard stop for anyone else.
  if (invitation.status === "accepted") {
    if (invitation.acceptedByUserId && invitation.acceptedByUserId === input.user.id) {
      return {
        status: "accepted",
        teacherId: invitation.teacherId,
        studentId: invitation.studentId,
        linkedStudentId: invitation.studentId,
        alreadyAccepted: true,
        existingAccount: false,
      };
    }
    return { status: "accepted_by_other" };
  }
  if (invitation.status === "cancelled") return { status: "cancelled" };
  if (effectiveInvitationStatus(invitation) === "expired") return { status: "expired" };

  // Hijack guard: the accepting inbox must match the invited inbox. A verified
  // email (email-OTP proves control of the inbox; Google gives a verified
  // email) is required — no email, no match.
  if (!userEmail || userEmail !== invitedEmail) {
    return { status: "email_mismatch", invitedEmail: invitation.email };
  }

  // Link the auth identity to its rostered student row (idempotent; picks the
  // oldest matching row, refuses if the identity owns a Teacher row).
  const linked = await resolveLinkedStudent(input.user, db);
  if (linked.status === "conflict") return { status: "is_teacher" };
  // "none" would mean no rostered row matched the email — impossible here since
  // this invitation just provisioned one with this email on this teacher, but
  // guard rather than assert.
  const linkedStudentId = linked.status === "linked" ? linked.id : invitation.studentId;

  await db.$transaction(async (tx) => {
    // Clear THIS teacher's onboarding hold so lifecycle notifications flow.
    await tx.teacherStudent.updateMany({
      where: {
        teacherId: invitation.teacherId,
        studentId: invitation.studentId,
        onboardingHoldAt: { not: null },
      },
      data: { onboardingHoldAt: null },
    });
    // Mark accepted. Guard on status='pending' so a concurrent double-accept
    // only lands once (the second update matches zero rows).
    await tx.studentInvitation.updateMany({
      where: { id: invitation.id, status: "pending" },
      data: {
        status: "accepted",
        acceptedAt: new Date(),
        acceptedByUserId: input.user.id,
      },
    });
  });

  return {
    status: "accepted",
    teacherId: invitation.teacherId,
    studentId: invitation.studentId,
    linkedStudentId,
    alreadyAccepted: false,
    existingAccount: linked.status === "linked" ? linked.alreadyLinked : false,
  };
}

// Read-only invitation info for the accept LANDING (before the student signs
// in) — the teacher's name/photo + benefit context the page renders. Never
// exposes the token or PII beyond what the recipient already knows (their own
// email). Returns null for an unknown token; a shaped "state" for known ones so
// the page can show "expired"/"cancelled"/"accepted" without leaking anything.
export type InvitationLandingInfo = {
  state: "pending" | "expired" | "cancelled" | "accepted";
  invitedEmail: string;
  teacherName: string;
  teacherPhotoPath: string | null;
  teacherPhotoVersion: number;
  studentName: string | null;
};

export async function getInvitationLanding(
  rawToken: string,
  db: PrismaClient = prisma,
): Promise<InvitationLandingInfo | null> {
  if (!isWellFormedInvitationToken(rawToken)) return null;
  const invitation = await db.studentInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(rawToken) },
    select: {
      email: true,
      name: true,
      status: true,
      expiresAt: true,
      teacher: { select: { name: true, photoPath: true, updatedAt: true } },
      student: { select: { name: true } },
    },
  });
  if (!invitation) return null;
  const effective = effectiveInvitationStatus(invitation);
  return {
    state: effective,
    invitedEmail: invitation.email,
    teacherName: invitation.teacher.name,
    teacherPhotoPath: invitation.teacher.photoPath,
    teacherPhotoVersion: invitation.teacher.updatedAt.getTime(),
    studentName: invitation.name ?? invitation.student.name ?? null,
  };
}
