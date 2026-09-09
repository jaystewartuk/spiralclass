import { headers } from "next/headers";
import { APIError } from "better-auth/api";
import { auth } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";
import { sendEmailChangedNotice } from "@/lib/account/email-change-mail";
import {
  disconnectOAuthAccounts,
  revokeOtherSessionsBestEffort,
  revokeAllSessionsForUser,
} from "@/lib/auth/identity-change";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { logger } from "@/lib/logger";
import type { AppLocale } from "@/lib/i18n";
import { isAppLocale, DEFAULT_LOCALE } from "@spiralclass/shared";

const log = logger({ surface: "email-change" });

// Verified email change for students, on better-auth's emailOTP changeEmail
// endpoints (D-40).
//
// Email is the student's passwordless sign-in identity, so changing it has
// to move BOTH the better-auth `user` row and the Student row(s) — drifting
// them apart orphans the next sign-in (a fresh user that can never re-link,
// see resolveLinkedStudent). The flow:
//
//   1. `requestStudentEmailChange` — the signed-in student names a new
//      address. auth.api.requestEmailChangeEmailOTP mints a code and, via
//      our sendVerificationOTP callback (lib/auth/email-otp-delivery.ts),
//      emails it to the NEW address — proving ownership before anything
//      changes.
//   2. `verifyStudentEmailChange` — the student types that code back in.
//      auth.api.changeEmailEmailOTP verifies it and flips `user.email`
//      in the same call. We then disconnect any linked Google (or other
//      OAuth) account and sign out every other session (see
//      lib/auth/identity-change.ts) before syncing every Student row that
//      carried the old address — the linked row plus the same person's rows
//      under other teachers — then audit and notify the OLD inbox.
//
// Single confirmation by design: the most common reason to change email is
// losing access to the old inbox, so we never require a click from it —
// verifyCurrentEmail stays OFF for this project. The old address gets a
// security NOTICE instead, and the change is detectable/reversible through
// support.
//
// Google Sign-In identity (security-critical — do not remove): a Google
// sign-in resolves purely by (providerId, accountId), never by email, so a
// stale Google Account row left linked after an email change would let the
// ORIGINAL Google account keep signing in to this student forever, whatever
// email now sits on the row. disconnectOAuthAccounts() is what closes that.
// Reconnecting Google under the new address is a separate, explicit step —
// never automatic, never required (email-OTP sign-in always still works).
//
// The admin path (`adminSetStudentEmail`) is the escape hatch for "I lost
// my old inbox AND my session" support cases: the operator verifies
// identity out-of-band and updates auth + rows directly. It still goes
// through Supabase's admin API (auth.users is kept dormant, not deleted,
// through the D-40 rollback window) — see docs/decisions/D-40.md.

export type EmailChangeRequestResult =
  | { ok: true; pendingEmail: string }
  | { ok: false; error: "same-email" | "not-linked" | "unavailable" | "send-failed" };

export type EmailChangeVerifyResult =
  { ok: true; googleDisconnected: boolean } | { ok: false; error: "invalid-code" | "unavailable" };

export type AdminEmailChangeResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: "not-found" | "email-taken" | "unavailable" };

function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

// Step 1 — mint + send the change-email code to the NEW address. Nothing is
// persisted on our side; better-auth tracks the pending verification record.
export async function requestStudentEmailChange(input: {
  student: { id: string; authUserId: string | null; email: string | null };
  newEmail: string;
}): Promise<EmailChangeRequestResult> {
  const { student } = input;
  // Only linked students have an auth identity to move. Unlinked rows are
  // teacher-editable contact cards (Phase 1) — nothing to verify here.
  if (!student.authUserId) return { ok: false, error: "not-linked" };

  const newEmail = normalizeEmail(input.newEmail);
  if (student.email && normalizeEmail(student.email) === newEmail) {
    return { ok: false, error: "same-email" };
  }

  try {
    await auth.api.requestEmailChangeEmailOTP({
      body: { newEmail },
      headers: await headers(),
    });
  } catch (err) {
    log.error("requestEmailChangeEmailOTP failed", err, { studentId: student.id });
    return { ok: false, error: err instanceof APIError ? "unavailable" : "send-failed" };
  }
  return { ok: true, pendingEmail: newEmail };
}

// Step 2 — verify the code and flip the identity, then heal the Student
// row(s) to match. Best-effort on the row sync: a failure there is logged
// but the identity change (the auth-of-record fact) already succeeded.
export async function verifyStudentEmailChange(input: {
  studentAuthUserId: string;
  newEmail: string;
  otp: string;
}): Promise<EmailChangeVerifyResult> {
  const newEmail = normalizeEmail(input.newEmail);
  try {
    await auth.api.changeEmailEmailOTP({
      body: { newEmail, otp: input.otp },
      headers: await headers(),
    });
  } catch (err) {
    log.warn("changeEmailEmailOTP failed", { authUserId: input.studentAuthUserId, error: err });
    return { ok: false, error: err instanceof APIError ? "invalid-code" : "unavailable" };
  }

  const { disconnectedProviders } = await disconnectOAuthAccounts(input.studentAuthUserId);
  await revokeOtherSessionsBestEffort();

  await syncStudentEmailFromAuth({
    id: input.studentAuthUserId,
    email: newEmail,
    disconnectedGoogle: disconnectedProviders.includes("google"),
  });
  return { ok: true, googleDisconnected: disconnectedProviders.includes("google") };
}

// Step 3 — heal the Student rows whenever the auth email and the linked
// row's email disagree (normally right after an email_change verification;
// also self-heals operator dashboard changes). Returns true when rows moved.
//
// Best-effort by contract: callers on the sign-in path must not let a
// failure here block the redirect — a missed sync retries on the next
// callback pass because the mismatch persists.
export async function syncStudentEmailFromAuth(user: {
  id: string;
  email?: string | null;
  // True when this sync followed disconnectOAuthAccounts() removing a linked
  // Google account — folded into the old-inbox notice copy.
  disconnectedGoogle?: boolean;
}): Promise<boolean> {
  if (!user.email) return false;
  const newEmail = normalizeEmail(user.email);

  const linked = await prisma.student.findFirst({
    where: { authUserId: user.id },
    select: { id: true, email: true, name: true, locale: true },
  });
  if (!linked) return false;
  const oldEmail = linked.email;
  if (oldEmail && normalizeEmail(oldEmail) === newEmail) return false;

  const affected = await applyEmailChangeRows({
    linkedStudentId: linked.id,
    oldEmail,
    newEmail,
    actor: { type: "student" },
  });

  trackServerEvent({
    name: "student_contact_updated",
    distinctId: linked.id,
    properties: { studentId: linked.id, actorType: "student", fields: ["email"] },
  });

  // Security notice to the old inbox — detection, not confirmation (see
  // the single-confirmation rationale above). Best-effort.
  if (oldEmail) {
    try {
      await sendEmailChangedNotice({
        to: oldEmail,
        newEmail,
        locale: isAppLocale(linked.locale) ? linked.locale : DEFAULT_LOCALE,
        disconnectedGoogle: user.disconnectedGoogle ?? false,
      });
    } catch (err) {
      log.error("old-address notice failed", err, {
        studentId: linked.id,
        which: "old-address-notice",
      });
    }
  }

  return affected > 0;
}

// Support path: operator verified the student's identity out-of-band and
// sets the email directly — auth user first (when linked), then rows.
// For unlinked students this is just a row edit with the same roster
// uniqueness rule the teacher path enforces.
export async function adminSetStudentEmail(input: {
  studentId: string;
  newEmail: string;
  actorAdminId: string | null;
}): Promise<AdminEmailChangeResult> {
  const newEmail = normalizeEmail(input.newEmail);
  const student = await prisma.student.findUnique({
    where: { id: input.studentId },
    select: {
      id: true,
      email: true,
      authUserId: true,
      locale: true,
      teacherStudents: { select: { teacherId: true } },
    },
  });
  if (!student) return { ok: false, error: "not-found" };
  if (student.email && normalizeEmail(student.email) === newEmail) {
    return { ok: true, changed: false };
  }

  // Checkout dedupes by (email + teacher): refuse an address already used
  // by a different student on any of this student's rosters.
  const teacherIds = student.teacherStudents.map((l) => l.teacherId);
  if (teacherIds.length > 0) {
    const collision = await prisma.student.findFirst({
      where: {
        email: { equals: newEmail, mode: "insensitive" },
        id: { not: student.id },
        teacherStudents: { some: { teacherId: { in: teacherIds } } },
      },
      select: { id: true },
    });
    if (collision) return { ok: false, error: "email-taken" };
  }

  let disconnectedGoogle = false;
  if (student.authUserId) {
    try {
      await prisma.user.update({
        where: { id: student.authUserId },
        data: { email: newEmail, emailVerified: true },
      });
    } catch (error) {
      // Most commonly P2002 (unique constraint) — the address already
      // belongs to another better-auth user.
      log.error("admin user.email update failed", error, {
        studentId: student.id,
        which: "admin-update",
      });
      return { ok: false, error: "unavailable" };
    }

    // Same identity-security step as the self-service flow (see
    // lib/auth/identity-change.ts): an admin-set email must not leave a
    // stale Google Account row that still resolves to this student via the
    // OLD Google identity. The current request is the ADMIN's session, not
    // the student's, so sessions are revoked by user id, not "other than
    // current."
    const { disconnectedProviders } = await disconnectOAuthAccounts(student.authUserId);
    disconnectedGoogle = disconnectedProviders.includes("google");
    await revokeAllSessionsForUser(student.authUserId);
  }

  await applyEmailChangeRows({
    linkedStudentId: student.id,
    oldEmail: student.email,
    newEmail,
    actor: { type: "admin", adminId: input.actorAdminId },
  });

  trackServerEvent({
    name: "student_contact_updated",
    distinctId: student.id,
    properties: { studentId: student.id, actorType: "admin", fields: ["email"] },
  });

  // Notices only make sense for accounts that can sign in — an unlinked
  // row is just roster contact data and its old address was never
  // verified. Old inbox gets the security notice; new inbox gets a
  // confirmation the support request landed. Both best-effort.
  if (student.authUserId) {
    const locale: AppLocale = isAppLocale(student.locale) ? student.locale : DEFAULT_LOCALE;
    if (student.email) {
      try {
        await sendEmailChangedNotice({ to: student.email, newEmail, locale, disconnectedGoogle });
      } catch (err) {
        log.error("old-address notice failed", err, {
          studentId: student.id,
          which: "admin-old-address-notice",
        });
      }
    }
    try {
      await sendEmailChangedNotice({ to: newEmail, newEmail, locale, disconnectedGoogle: false });
    } catch (err) {
      log.error("new-address notice failed", err, {
        studentId: student.id,
        which: "admin-new-address-notice",
      });
    }
  }

  return { ok: true, changed: true };
}

// Move every Student row carrying the old address (the linked row plus the
// same person's rows under other teachers — same inbox, same person) and
// write one audit row per moved row. Returns the number of rows moved.
async function applyEmailChangeRows(input: {
  linkedStudentId: string;
  oldEmail: string | null;
  newEmail: string;
  actor: { type: "student" } | { type: "admin"; adminId: string | null };
}): Promise<number> {
  const { linkedStudentId, oldEmail, newEmail, actor } = input;
  return prisma.$transaction(async (tx) => {
    const rows = oldEmail
      ? await tx.student.findMany({
          where: { email: { equals: oldEmail, mode: "insensitive" } },
          select: { id: true, email: true },
        })
      : await tx.student.findMany({
          where: { id: linkedStudentId },
          select: { id: true, email: true },
        });
    if (rows.length === 0) return 0;

    await tx.student.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { email: newEmail },
    });
    await tx.studentContactChange.createMany({
      data: rows.map((r) => ({
        studentId: r.id,
        actorType: actor.type,
        actorAdminId: actor.type === "admin" ? actor.adminId : null,
        beforeJson: { email: r.email },
        afterJson: { email: newEmail },
      })),
    });
    return rows.length;
  });
}
