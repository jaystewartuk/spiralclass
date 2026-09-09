import { beforeEach, describe, expect, it, vi } from "vitest";

// D-38: Teacher and Student are mutually exclusive roles per auth identity.
// Pins the "conflict" branch of resolveLinkedStudent surfacing a clear,
// locale-aware redirect — not a silent dead end — across every caller:
// finalizeSignIn (this file) and the mobile /api/mobile/auth/verify-otp route
// (tests/mobile/verify-otp-route.test.ts).

const state: {
  teacher: { id: string; onboardingCompleteAt: Date | null } | null;
  linkStatus: "linked" | "conflict" | "none";
} = {
  teacher: null,
  linkStatus: "none",
};

vi.mock("@/lib/env", () => ({ isSuperuser: () => false }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: { findUnique: async () => state.teacher },
    // finalizeSignIn now also checks loadAdminActor (lib/admin.ts) for a
    // DB-backed admin — no admin_users rows in scope for this test.
    adminUser: { findUnique: async () => null, count: async () => 0 },
  },
}));

vi.mock("@/lib/auth/student-link", () => ({
  resolveLinkedStudent: async () => ({ status: state.linkStatus }),
}));

const { finalizeSignIn } = await import("@/app/actions/session");

const USER = { id: "u-1", email: "mira@example.com" };

beforeEach(() => {
  state.teacher = null;
  state.linkStatus = "none";
});

describe("finalizeSignIn — Teacher/Student conflict (D-38)", () => {
  it("redirects to sign-in with an explanatory error instead of linking", async () => {
    state.linkStatus = "conflict";
    expect(await finalizeSignIn(null, USER)).toBe("/sign-in?error=teacher-email-conflict");
  });

  it("redirects to sign-in with no-session when there's no signed-in user", async () => {
    expect(await finalizeSignIn(null, null)).toBe("/sign-in?error=no-session");
  });
});

describe("finalizeSignIn — brand-new identity intent gating (D-56)", () => {
  it("refuses to provision a teacher on the sign-in default and bounces with no-account", async () => {
    expect(await finalizeSignIn(null, USER)).toBe(
      "/sign-in?error=no-account&email=mira%40example.com",
    );
  });

  it("refuses to provision a teacher on an explicit sign-in intent", async () => {
    expect(await finalizeSignIn(null, USER, "sign-in")).toBe(
      "/sign-in?error=no-account&email=mira%40example.com",
    );
  });

  it("sends a sign-up intent to onboarding, where requireTeacher() lazy-creates the row", async () => {
    expect(await finalizeSignIn(null, USER, "sign-up")).toBe("/onboarding/reading");
  });
});
