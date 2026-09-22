import { beforeEach, describe, expect, it, vi } from "vitest";

// Superusers are operator accounts (env `SUPERUSER_EMAILS`) that never have a
// teacher or student row. finalizeSignIn (app/actions/session.ts, run right
// after verifySignInCodeAction establishes a better-auth session) must route
// them straight to `/admin` (honouring an explicit `next`) BEFORE the
// teacher/student lookup. Non-superusers keep their existing
// teacher/student/new-signup resolution.
//
// finalizeSignIn takes the signed-in user as a direct argument (NOT via
// getAuthUser()/headers() — see its own comment for why), so these tests
// pass a user object straight in rather than mocking @/lib/auth.

const state: {
  superuserEmails: string[];
  adminEmails: string[];
  teacher: { id: string; onboardingCompleteAt: Date | null } | null;
  linkedStudent: boolean;
} = {
  superuserEmails: [],
  adminEmails: [],
  teacher: null,
  linkedStudent: false,
};

vi.mock("@/lib/env", () => ({
  isSuperuser: (email?: string | null) =>
    !!email && state.superuserEmails.includes(email.toLowerCase()),
}));

// A DB-backed admin_users row, independent of SUPERUSER_EMAILS — the
// support/finance admin case (D-25 model): a real admin with no env entry.
vi.mock("@/lib/admin", () => ({
  loadAdminActor: async (email: string) =>
    state.adminEmails.includes(email) ? { id: "admin-1", email, role: "support" } : null,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: { findUnique: async () => state.teacher },
  },
}));

vi.mock("@/lib/auth/student-link", () => ({
  resolveLinkedStudent: async () =>
    state.linkedStudent ? { status: "linked", id: "s-1" } : { status: "none" },
}));

const { finalizeSignIn } = await import("@/app/actions/session");

beforeEach(() => {
  state.superuserEmails = [];
  state.adminEmails = [];
  state.teacher = null;
  state.linkedStudent = false;
});

describe("finalizeSignIn — superuser routing", () => {
  it("sends a superuser to /admin without a teacher/student lookup", async () => {
    state.superuserEmails = ["admin@spiralclass.com"];
    expect(await finalizeSignIn(null, { id: "u-1", email: "admin@spiralclass.com" })).toBe(
      "/admin",
    );
  });

  it("honours an explicit next for a superuser", async () => {
    state.superuserEmails = ["admin@spiralclass.com"];
    expect(
      await finalizeSignIn("/admin/staff", { id: "u-1", email: "admin@spiralclass.com" }),
    ).toBe("/admin/staff");
  });

  it("still routes a non-superuser teacher to /dashboard", async () => {
    state.teacher = { id: "u-2", onboardingCompleteAt: new Date() };
    expect(await finalizeSignIn(null, { id: "u-2", email: "maestra@example.com" })).toBe(
      "/dashboard",
    );
  });

  it("bounces a non-superuser with no teacher/student row to no-account on the sign-in default (D-56)", async () => {
    // Under better-auth (D-40) every verified email has a User row — there's
    // no more "verified but no account" state at the identity layer. But
    // D-56 only lets an explicit sign-up intent provision a Teacher for a
    // fresh identity — the sign-in default refuses instead of silently
    // becoming a new signup.
    expect(await finalizeSignIn(null, { id: "u-3", email: "nadie@example.com" })).toBe(
      "/sign-in?error=no-account&email=nadie%40example.com",
    );
  });

  it("routes a non-superuser with no teacher/student row to onboarding on sign-up intent", async () => {
    expect(await finalizeSignIn(null, { id: "u-3", email: "nadie@example.com" }, "sign-up")).toBe(
      "/onboarding/reading",
    );
  });

  it("sends a DB-only admin (admin_users row, no SUPERUSER_EMAILS entry) to /admin", async () => {
    state.adminEmails = ["support@spiralclass.com"];
    expect(await finalizeSignIn(null, { id: "u-4", email: "support@spiralclass.com" })).toBe(
      "/admin",
    );
  });

  it("routes a DB-only admin to /admin ahead of a Teacher row on the same email", async () => {
    // Mirrors admin.ts's getAdminEmails comment: a staff member's own
    // dev/test session can mint a real Teacher row. Admin must still win.
    state.adminEmails = ["support@spiralclass.com"];
    state.teacher = { id: "u-4", onboardingCompleteAt: new Date() };
    expect(await finalizeSignIn(null, { id: "u-4", email: "support@spiralclass.com" })).toBe(
      "/admin",
    );
  });
});
