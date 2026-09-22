import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

const log = logger({ surface: "identity-change" });

// Runs right after a verified email change flips `user.email` (teacher or
// student, OTP-driven or admin-driven — see lib/teachers/email-change.ts,
// lib/students/email-change.ts). Closes the Google-OAuth account-takeover gap:
// better-auth resolves a Google sign-in purely by (providerId, accountId) —
// Google's stable subject id, which never changes — never by email (see
// findOAuthUser in better-auth's internal adapter). Changing `user.email`
// alone leaves any linked `Account` row untouched, so the ORIGINAL Google
// account a teacher/student signed up with keeps signing in to this row
// forever, regardless of what email now sits on it. Deleting every linked
// Account row here closes that immediately, independent of whether the user
// ever reconnects Google under the new address (see
// lib/auth/google-link-status.ts + the /link-social reconnect flow for that).
//
// A direct Prisma delete, not auth.api.unlinkAccount, deliberately sidesteps
// two better-auth guards that don't apply to our passwordless model:
//   - freshSessionMiddleware: requires the session to have been CREATED
//     (not just active) within sessionConfig.freshAge. A teacher can change
//     email from a session that's days old; that's normal here, not stale.
//   - "can't unlink your last linked account": irrelevant — email-OTP sign-in
//     never creates an Account row at all (it's core to User, not a linked
//     account), so it's always still available as a fallback sign-in method
//     even with zero Account rows.
export async function disconnectOAuthAccounts(userId: string): Promise<{
  disconnectedProviders: string[];
}> {
  const stale = await prisma.account.findMany({
    where: { userId },
    select: { providerId: true },
  });
  if (stale.length === 0) return { disconnectedProviders: [] };

  await prisma.account.deleteMany({ where: { userId } });
  return { disconnectedProviders: [...new Set(stale.map((a) => a.providerId))] };
}

// Best-effort: sign out every OTHER active session for this user so a device
// that was already signed in — including, notably, one opened via the OAuth
// identity that's about to be disconnected — doesn't stay silently signed in
// after the email/identity change. Never blocks the caller's own success
// response; a failure here just means a stale session outlives the change by
// a bit longer, not that the change itself failed.
//
// Uses the CURRENT request's session (via next/headers) to know which one to
// keep — only correct for a self-service change (the signed-in teacher/
// student changing their OWN email). For an admin-driven change, the current
// session belongs to the admin, not the target user — use
// revokeAllSessionsForUser instead.
export async function revokeOtherSessionsBestEffort(): Promise<void> {
  try {
    await auth.api.revokeOtherSessions({ headers: await headers() });
  } catch (err) {
    log.warn("revokeOtherSessions failed", { error: err });
  }
}

// Admin-driven equivalent: revokes ALL sessions for a given user id, not
// "every session but the caller's" — there is no sense in which the calling
// admin's own session is "this user's session." A direct Prisma delete, not
// auth.api.revokeUserSessions (the admin plugin's own endpoint): that
// endpoint gates on better-auth's own `User.role` field via its permission
// system, which this app doesn't populate — app admin status lives in the
// separate `AdminUser` table (see CLAUDE.md), so every real app-admin caller
// would be rejected as FORBIDDEN. Same bypass precedent as the account-
// deletion job's session cleanup (lib/inngest/functions/account-deletion.ts).
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  try {
    await prisma.session.deleteMany({ where: { userId } });
  } catch (err) {
    log.warn("revokeAllSessionsForUser failed", { error: err, userId });
  }
}
