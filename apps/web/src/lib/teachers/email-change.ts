import { headers } from "next/headers";
import { APIError } from "better-auth/api";
import { auth } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";
import { sendEmailChangedNotice } from "@/lib/account/email-change-mail";
import { disconnectOAuthAccounts, revokeOtherSessionsBestEffort } from "@/lib/auth/identity-change";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { logger } from "@/lib/logger";
import { isAppLocale, DEFAULT_LOCALE } from "@spiralclass/shared";

const log = logger({ surface: "email-change" });

// Verified email change for teachers, on better-auth's emailOTP changeEmail
// endpoints (D-40) — the teacher twin of lib/students/email-change.ts. Email
// is the teacher's passwordless sign-in identity, so changing it has to move
// BOTH the better-auth `user` row and the Teacher row. Unlike students (whose
// auth id lives in a separate authUserId column and who can have sibling rows
// across teachers), a Teacher row's primary key IS the auth user id
// (Teacher.id == user.id), so the sync is a single-row update keyed on that id.
//
// Flow:
//   1. `requestTeacherEmailChange` — the signed-in teacher names a new
//      address. auth.api.requestEmailChangeEmailOTP mints a code and, via our
//      sendVerificationOTP callback (lib/auth/email-otp-delivery.ts), emails
//      it to the NEW address — proving ownership of the new inbox before
//      anything changes.
//   2. `verifyTeacherEmailChange` — the teacher types that code back in.
//      auth.api.changeEmailEmailOTP verifies it and flips `user.email`
//      in the same call. We then disconnect any linked Google (or other
//      OAuth) account and sign out every other session — see
//      lib/auth/identity-change.ts for why — before syncing the Teacher row.
//
// Single confirmation by design, same as students: "verify current email"
// stays OFF for this project (verifyCurrentEmail: false) — the caller is
// already an authenticated session. The old address gets a security NOTICE
// instead of a required click.
//
// Google Sign-In identity (security-critical — do not remove): a Google
// sign-in resolves purely by (providerId, accountId), never by email, so
// leaving a stale Google Account row linked after an email change would let
// the ORIGINAL Google account keep signing in to this teacher forever,
// whatever email now sits on the row (the account-takeover bug this closes).
// disconnectOAuthAccounts() below is what makes that impossible. Reconnecting
// Google under the new address is a separate, explicit step the teacher takes
// from settings (lib/auth/google-link-status.ts + the /link-social flow) —
// never automatic, and never required to keep using the account (email-OTP
// sign-in always still works).

export type TeacherEmailChangeResult =
  | { ok: true; pendingEmail: string }
  | { ok: false; error: "same-email" | "unavailable" | "send-failed" };

export type TeacherEmailChangeVerifyResult =
  { ok: true; googleDisconnected: boolean } | { ok: false; error: "invalid-code" | "unavailable" };

function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

// Step 1 — mint + send the change-email code to the NEW address. Nothing is
// persisted on our side; better-auth tracks the pending verification record.
export async function requestTeacherEmailChange(input: {
  teacher: { id: string; email: string | null };
  newEmail: string;
}): Promise<TeacherEmailChangeResult> {
  const { teacher } = input;
  const newEmail = normalizeEmail(input.newEmail);
  if (teacher.email && normalizeEmail(teacher.email) === newEmail) {
    return { ok: false, error: "same-email" };
  }

  try {
    await auth.api.requestEmailChangeEmailOTP({
      body: { newEmail },
      headers: await headers(),
    });
  } catch (err) {
    log.error("requestEmailChangeEmailOTP failed", err, { teacherId: teacher.id });
    return { ok: false, error: err instanceof APIError ? "unavailable" : "send-failed" };
  }
  return { ok: true, pendingEmail: newEmail };
}

// Step 2 — verify the code and flip the identity, then heal the Teacher row
// to match. Best-effort on the row sync: a failure there is logged but the
// identity change (the auth-of-record fact) already succeeded.
export async function verifyTeacherEmailChange(input: {
  teacherId: string;
  newEmail: string;
  otp: string;
}): Promise<TeacherEmailChangeVerifyResult> {
  const newEmail = normalizeEmail(input.newEmail);
  try {
    await auth.api.changeEmailEmailOTP({
      body: { newEmail, otp: input.otp },
      headers: await headers(),
    });
  } catch (err) {
    log.warn("changeEmailEmailOTP failed", { teacherId: input.teacherId, error: err });
    return { ok: false, error: err instanceof APIError ? "invalid-code" : "unavailable" };
  }

  // Identity is already flipped at this point — everything below is
  // security hardening around that fact, not part of "did the change
  // succeed." disconnectOAuthAccounts throwing would be a real bug (not
  // best-effort by contract, unlike the notice email), so it's allowed to
  // propagate; revokeOtherSessionsBestEffort swallows its own errors.
  const { disconnectedProviders } = await disconnectOAuthAccounts(input.teacherId);
  await revokeOtherSessionsBestEffort();

  await syncTeacherEmailFromAuth({
    id: input.teacherId,
    email: newEmail,
    disconnectedGoogle: disconnectedProviders.includes("google"),
  });
  return { ok: true, googleDisconnected: disconnectedProviders.includes("google") };
}

// Heals the Teacher row whenever the auth email and the row disagree
// (normally right after a change-email verification; also self-heals
// operator dashboard changes). Returns true when the row moved.
//
// Best-effort by contract: callers must not let a failure here block the
// caller's own success response — a missed sync retries on the next pass
// because the mismatch persists.
export async function syncTeacherEmailFromAuth(user: {
  id: string;
  email?: string | null;
  // True when this sync followed disconnectOAuthAccounts() removing a linked
  // Google account — folded into the old-inbox notice copy so the teacher
  // isn't surprised when Google Sign-In stops working for the old address.
  disconnectedGoogle?: boolean;
}): Promise<boolean> {
  if (!user.email) return false;
  const newEmail = normalizeEmail(user.email);

  const teacher = await prisma.teacher.findUnique({
    where: { id: user.id },
    select: { id: true, email: true, locale: true },
  });
  if (!teacher) return false;
  const oldEmail = teacher.email;
  if (oldEmail && normalizeEmail(oldEmail) === newEmail) return false;

  // The teacher PK is the auth id, so this is a single-row move. `email` is
  // @unique on teachers — if the address somehow collides we let it throw so
  // the caller's best-effort catch logs it and the next pass retries.
  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { email: newEmail },
  });

  trackServerEvent({
    name: "teacher_email_updated",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, actorType: "teacher" },
  });

  // Security notice to the old inbox — detection, not confirmation.
  if (oldEmail) {
    try {
      await sendEmailChangedNotice({
        to: oldEmail,
        newEmail,
        locale: isAppLocale(teacher.locale) ? teacher.locale : DEFAULT_LOCALE,
        disconnectedGoogle: user.disconnectedGoogle ?? false,
      });
    } catch (err) {
      log.error("old-address notice failed", err, {
        teacherId: teacher.id,
        which: "old-address-notice",
      });
    }
  }

  return true;
}
