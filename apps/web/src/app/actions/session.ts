"use server";

import { prisma } from "@/lib/prisma";
import { resolveLinkedStudent } from "@/lib/auth/student-link";
import { safeNextPath } from "@/lib/auth/safe-next";
import { isSuperuser } from "@/lib/env";
import { loadAdminActor } from "@/lib/admin";

type SignedInUser = { id: string; email: string };

// Which button/form the user actually used to get here — sourced from the
// page, never inferred from whether the identity is unmatched (D-56). Only
// "sign-up" is allowed to lazy-create a Teacher row for a brand-new
// identity; "sign-in" (the default) bounces to a clear "no account" message
// instead. This is what stops a mistyped/unrostered email typed into the
// generic /sign-in page from silently becoming a full teacher account.
export type SignInIntent = "sign-in" | "sign-up";

// Runs right after verifySignInCodeAction (app/actions/auth.ts) establishes
// the better-auth session, to resolve the role-aware landing page. The
// client component does the actual navigation (redirect() from the same
// action that called this).
//
// Takes the just-signed-in user DIRECTLY from signInEmailOTP's own return
// value — NOT via getAuthUser()/headers(). Next.js Server Actions apply
// Set-Cookie to the outgoing response, but `headers()`/`cookies()` reads
// later in the SAME action still reflect the incoming request, before that
// cookie exists — so a getAuthUser() call here would see no session at all
// and always 404 into "/sign-in?error=no-session", even on a fully
// successful sign-in. Caught via a real preview OTP login, not by unit tests
// (which mock getAuthUser() directly and never model this timing).
export async function finalizeSignIn(
  next: string | null,
  user: SignedInUser | null,
  intent: SignInIntent = "sign-in",
): Promise<string> {
  if (!user) return "/sign-in?error=no-session";

  // Staff/admins are operator accounts (never teachers/students), so resolve
  // them straight to the admin panel before any role lookup. Checks the
  // SUPERUSER_EMAILS env allowlist first (cheap, no DB round-trip) OR a real
  // admin_users row — a support/finance admin added only via /admin/staff
  // (no env entry) must land here too, not fall through to a stray
  // Teacher/Student row (the same rule the deleted mobile session payload used).
  if (isSuperuser(user.email) || (await loadAdminActor(user.email))) {
    return safeNextPath(next) ?? "/admin";
  }

  const teacher = await prisma.teacher.findUnique({
    where: { id: user.id },
    select: { id: true, onboardingCompleteAt: true },
  });
  if (teacher) {
    if (!teacher.onboardingCompleteAt) return "/onboarding/reading";
    return safeNextPath(next) ?? "/dashboard";
  }

  const linked = await resolveLinkedStudent(user);
  if (linked.status === "conflict") {
    // This email already owns a Teacher row — Teacher and Student are
    // mutually exclusive per auth identity, so refuse to merge them.
    return "/sign-in?error=teacher-email-conflict";
  }
  if (linked.status === "linked") {
    return safeNextPath(next) ?? "/my-classes";
  }

  // Under better-auth (D-40) every verified email now has a User row — there
  // is no more "verified but no account" state at the identity layer. But an
  // identity with neither a Teacher nor a linked Student row only gets
  // routed to onboarding (where requireTeacher() lazy-creates the Teacher
  // row) when the user actually came through /sign-up. A /sign-in with an
  // unmatched identity means "no account for this email" — D-56 — never a
  // silent teacher signup.
  if (intent === "sign-up") return "/onboarding/reading";
  return `/sign-in?error=no-account&email=${encodeURIComponent(user.email)}`;
}
