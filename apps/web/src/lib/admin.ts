import { redirect } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isSuperuser } from "@/lib/env";
import { identifyServerUser } from "@/lib/analytics/posthog";
import { logger } from "@/lib/logger";
import { hasCapability, type AdminCapability } from "@/lib/admin-capabilities";
import { hasValidAdminStepUp } from "@/lib/auth/admin-stepup";
import type { AdminRole } from "@prisma/client";

const log = logger({ surface: "admin" });

// Role hierarchy (descending privilege). Higher tiers automatically
// satisfy lower-tier role requirements. `tester`/`engineer` rank below every
// existing tier on purpose — they're narrow, capability-gated roles (D-55,
// see lib/admin-capabilities.ts), not a rung on this ladder. They should
// never satisfy any existing `minRole` floor via rank; access comes only
// from an explicitly granted capability.
const ROLE_RANK: Record<AdminRole, number> = {
  superadmin: 3,
  finance: 2,
  support: 1,
  tester: 0,
  engineer: 0,
};

export type AdminActor = {
  id: string;
  email: string;
  role: AdminRole;
};

// Looks up the admin row by email. If no rows exist in `admin_users` yet
// but the caller's email is in `SUPERUSER_EMAILS` (env / BUILTIN_SUPERUSERS),
// returns a synthetic superadmin actor so the panel is reachable on a fresh
// DB. As soon as one real row exists, the env fallback no longer applies.
export async function loadAdminActor(email: string): Promise<AdminActor | null> {
  const row = await prisma.adminUser.findUnique({ where: { email } });
  if (row) {
    if (row.disabledAt) return null;
    return { id: row.id, email: row.email, role: row.role };
  }

  const adminCount = await prisma.adminUser.count();
  if (adminCount === 0 && isSuperuser(email)) {
    // The env-allowlist backdoor is active. This synthetic superadmin is
    // UNATTRIBUTED — its audit rows carry actorAdminId = NULL — so the path
    // must be transient: seed a real admin_users row from /admin/staff, then
    // BLANK SUPERUSER_EMAILS in prod so it can never re-arm if rows are later
    // removed. Make it observable so a lingering bootstrap is noticed.
    // See docs/decisions/D-25.md.
    log.warn("admin authorised via env-allowlist bootstrap (no admin_users row yet)", {
      email,
    });
    Sentry.setTag("admin_bootstrap", "true");
    return { id: BOOTSTRAP_ACTOR_ID, email, role: "superadmin" };
  }
  return null;
}

// Sentinel id used when the env-allowlist bootstrap path is active.
// Override.actorAdminId stays NULL for these (the FK requires a real row);
// the bootstrap flow should only be used to seed real admins from /admin/staff,
// after which DB rows take over.
export const BOOTSTRAP_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

export function isBootstrapActor(actor: { id: string }): boolean {
  return actor.id === BOOTSTRAP_ACTOR_ID;
}

export function meetsRole(actor: { role: AdminRole }, minRole: AdminRole): boolean {
  return ROLE_RANK[actor.role] >= ROLE_RANK[minRole];
}

// Emails with an admin_users row. A staff member's own dev/test session can
// mint a real Teacher row (auth.ts requireTeacher() auto-creates one for any
// signed-in email that hits a teacher page), so admin-facing teacher lists
// exclude these emails to avoid showing staff accounts as real teachers.
export async function getAdminEmails(): Promise<string[]> {
  const rows = await prisma.adminUser.findMany({ select: { email: true } });
  return rows.map((r) => r.email);
}

// Teachers for admin filter dropdowns (Students/Audit log "by teacher"),
// with staff/admin emails excluded per getAdminEmails() above.
export async function listFilterableTeachers(): Promise<
  Array<{ id: string; name: string; email: string }>
> {
  const adminEmails = await getAdminEmails();
  return prisma.teacher.findMany({
    where: adminEmails.length ? { email: { notIn: adminEmails } } : undefined,
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true },
  });
}

// Where the admin gate sends a session that hasn't cleared MFA. The page at
// this path enrols a factor (first time) or accepts a step-up code, then
// bounces back to /admin. It is the ONE admin surface gated by
// resolveAdminActor() rather than requireAdmin(): requiring AAL2 to reach the
// page that grants AAL2 would be an infinite redirect loop.
export const ADMIN_MFA_PATH = "/admin/security";

// Resolve + authorise the admin actor for the current session WITHOUT the MFA
// assurance check. Use ONLY for the admin layout shell and the /admin/security
// step-up page. Every other admin page and server action must call
// requireAdmin(), which layers the mandatory AAL2 requirement on top.
// `capability`, when given, is an alternate path to authorization alongside
// `minRole` — an actor passes if EITHER their rank meets `minRole` OR they
// hold the named capability (D-55). This is how narrow roles like `tester`/
// `engineer`, which rank below every existing tier, reach a specific page
// without inheriting anything else on the rank ladder.
export async function resolveAdminActor(
  minRole: AdminRole = "support",
  capability?: AdminCapability,
): Promise<AdminActor> {
  const user = await getAuthUser();
  if (!user?.email) redirect("/sign-in?next=/admin");
  const actor = await loadAdminActor(user.email);
  if (!actor) redirect("/");
  const authorized =
    meetsRole(actor, minRole) || (capability != null && hasCapability(actor, capability));
  if (!authorized) redirect("/admin?error=forbidden");
  Sentry.setUser({ id: actor.id, email: actor.email });
  identifyServerUser(actor.id, { email: actor.email, role: "admin" });
  return actor;
}

// Primary admin gate. Use on every `/admin` page and every admin server action.
// Resolves + authorises the actor, then REQUIRES a second factor. A superadmin
// can read and modify every record, so — unlike the dropped teacher 2FA — MFA
// is MANDATORY for every admin tier, with no opt-out.
//
// Two layers (security audit H-1):
//   1. `user.twoFactorEnabled` — TOTP must be ENROLLED.
//   2. A fresh, session-bound step-up PROOF (lib/auth/admin-stepup.ts) — the
//      user must have actually PRESENTED a TOTP code recently. The only sign-in
//      rail is passwordless email-OTP, which better-auth's two-factor plugin
//      never challenges, so the enrolment flag alone would let anyone who reads
//      an admin's inbox reach full-privilege admin with no second factor.
//      Binding AAL2 to the session closes that. Either check failing sends the
//      user to ADMIN_MFA_PATH, which enrols (first time) or steps up.
// See docs/decisions/D-25.md and the D-40 migration plan.
//
//   await requireAdmin();              // any admin tier
//   await requireAdmin("finance");     // finance or superadmin
//   await requireAdmin("superadmin");  // superadmin only
//   await requireAdmin("superadmin", "uat:run"); // superadmin, OR any role
//                                                 // granted this capability
export async function requireAdmin(
  minRole: AdminRole = "support",
  capability?: AdminCapability,
): Promise<AdminActor> {
  const actor = await resolveAdminActor(minRole, capability);
  const user = await getAuthUser();
  if (!user?.twoFactorEnabled) redirect(ADMIN_MFA_PATH);
  // Require a fresh per-session TOTP step-up, not just enrolment. Bound to the
  // live session's auth user id so a proof can't be replayed across accounts.
  if (!(await hasValidAdminStepUp(user.id))) redirect(ADMIN_MFA_PATH);
  return actor;
}

// Backwards-compat wrapper for callers that pre-dated the role model.
// New code should call `requireAdmin("superadmin")` directly.
export async function requireSuperuser(): Promise<AdminActor> {
  return requireAdmin("superadmin");
}
