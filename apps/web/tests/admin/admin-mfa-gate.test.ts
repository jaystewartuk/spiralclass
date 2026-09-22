import { beforeEach, describe, expect, it, vi } from "vitest";

// The admin gate (src/lib/admin.ts) enforces MANDATORY 2FA: requireAdmin()
// redirects a user without twoFactorEnabled to the enrolment page, while
// resolveAdminActor() (used by the layout shell + the enrolment page itself)
// deliberately does NOT, so enrolment stays reachable. better-auth exposes no
// per-session "2FA-verified" flag (its two-factor hook only wires into
// password/username/phone sign-in, not our email-OTP rail), so the gate is the
// persistent user.twoFactorEnabled flag rather than a per-session check — see
// docs/decisions/D-25.md and the D-40 migration plan.

const redirectMock = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const getAuthUserMock = vi.fn();
vi.mock("@/lib/auth", () => ({ getAuthUser: getAuthUserMock }));

const adminFindUnique = vi.fn();
const adminCount = vi.fn(async () => 1);
vi.mock("@/lib/prisma", () => ({
  prisma: { adminUser: { findUnique: adminFindUnique, count: adminCount } },
}));

vi.mock("@/lib/env", () => ({ isSuperuser: vi.fn(() => false) }));
vi.mock("@/lib/analytics/posthog", () => ({ identifyServerUser: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ setUser: vi.fn(), setTag: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

// Per-session step-up proof (security audit H-1) — mocked so the gate test
// controls "did this session present a fresh TOTP code" independently of the
// enrolment flag.
const hasValidAdminStepUpMock = vi.fn(async () => true);
vi.mock("@/lib/auth/admin-stepup", () => ({ hasValidAdminStepUp: hasValidAdminStepUpMock }));

const { requireAdmin, resolveAdminActor, ADMIN_MFA_PATH } = await import("@/lib/admin");

const SUPERADMIN = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  role: "superadmin" as const,
  disabledAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUserMock.mockResolvedValue({
    id: SUPERADMIN.id,
    email: SUPERADMIN.email,
    twoFactorEnabled: false,
  });
  adminFindUnique.mockResolvedValue(SUPERADMIN);
  adminCount.mockResolvedValue(1);
  hasValidAdminStepUpMock.mockResolvedValue(true);
});

describe("requireAdmin 2FA enforcement", () => {
  it("targets the enrolment page at /admin/security", () => {
    expect(ADMIN_MFA_PATH).toBe("/admin/security");
  });

  it("redirects a user without twoFactorEnabled to the enrolment page", async () => {
    getAuthUserMock.mockResolvedValue({
      id: SUPERADMIN.id,
      email: SUPERADMIN.email,
      twoFactorEnabled: false,
    });
    await expect(requireAdmin()).rejects.toThrow(`REDIRECT:${ADMIN_MFA_PATH}`);
  });

  it("redirects an enrolled user WITHOUT a fresh step-up proof to the step-up page (H-1)", async () => {
    getAuthUserMock.mockResolvedValue({
      id: SUPERADMIN.id,
      email: SUPERADMIN.email,
      twoFactorEnabled: true,
    });
    hasValidAdminStepUpMock.mockResolvedValue(false);
    await expect(requireAdmin()).rejects.toThrow(`REDIRECT:${ADMIN_MFA_PATH}`);
  });

  it("returns the actor when enrolled AND the session holds a fresh step-up proof", async () => {
    getAuthUserMock.mockResolvedValue({
      id: SUPERADMIN.id,
      email: SUPERADMIN.email,
      twoFactorEnabled: true,
    });
    hasValidAdminStepUpMock.mockResolvedValue(true);
    const actor = await requireAdmin();
    expect(actor).toMatchObject({ id: SUPERADMIN.id, role: "superadmin" });
    expect(hasValidAdminStepUpMock).toHaveBeenCalledWith(SUPERADMIN.id);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("redirects to / when the user is not an admin at all", async () => {
    adminFindUnique.mockResolvedValue(null); // no admin_users row
    adminCount.mockResolvedValue(1); // rows exist → no env bootstrap
    await expect(requireAdmin()).rejects.toThrow("REDIRECT:/");
  });
});

describe("resolveAdminActor", () => {
  it("does NOT enforce twoFactorEnabled (so the enrolment page stays reachable)", async () => {
    getAuthUserMock.mockResolvedValue({ email: SUPERADMIN.email, twoFactorEnabled: false });
    const actor = await resolveAdminActor();
    expect(actor).toMatchObject({ id: SUPERADMIN.id, role: "superadmin" });
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
