import { resolve } from "node:path";

/**
 * Where the visual sweep's sessions come from, shared by the setup project
 * that creates them and the capture spec that consumes them.
 *
 * Defaults match `apps/web/scripts/seed.ts`, so a freshly seeded database
 * needs no configuration. Override any of them for a database seeded
 * differently.
 */

export type AuthedTier = "teacher" | "student" | "admin";

export const SESSION_EMAILS: Record<AuthedTier, string | undefined> = {
  // The teacher the E2E suite, the a11y sweep and the production synthetic
  // probe all use. Keeping one fixture across all four means a seed change
  // breaks them together rather than one at a time.
  teacher: process.env.VISUAL_TEACHER_EMAIL ?? "alicia.moreno@spiralclass.test",
  // One of that teacher's own students, so the portal renders real classes,
  // materials and progress rather than empty states.
  student: process.env.VISUAL_STUDENT_EMAIL ?? "maria@alumno.test",
  // Seeded into AdminUser. Note this is a different gate from the mobile
  // SUPERUSER_EMAILS allowlist — see docs/features/admin-portal.md.
  admin: process.env.VISUAL_ADMIN_EMAIL,
};

/** Saved storage state for a tier. Gitignored — it holds a real session cookie. */
export function statePath(tier: AuthedTier): string {
  return resolve(__dirname, "../../.auth", `${tier}.json`);
}

/**
 * Where each audience lands after signing in — a route that REQUIRES that
 * audience's session.
 *
 * This is not cosmetic. `signInAsViaOtp` escapes its `next` argument into a
 * regex and waits for the URL to match it, so passing "/" yields the pattern
 * `/`, which matches every URL — the wait then succeeds on the sign-in page
 * and the run proceeds with no session at all. Every target here must be a
 * route that redirects a signed-out visitor away.
 */
export const LANDING_AFTER_SIGN_IN: Record<AuthedTier, string> = {
  teacher: "/dashboard",
  student: "/my-classes",
  admin: "/admin",
};

/** Mirrors ADMIN_STEPUP_COOKIE in src/lib/auth/admin-stepup.ts. Duplicated
 * rather than imported because Playwright's test loader cannot pull in the
 * app's ESM lib wrappers — the same constraint that made tests/e2e/_helpers
 * import @prisma/client directly. The parity test below keeps them honest. */
export const ADMIN_STEPUP_COOKIE = "admin_stepup";
