import { beforeEach, describe, expect, it, vi } from "vitest";

// Pins the security-critical env-allowlist bootstrap backdoor (src/lib/admin.ts
// loadAdminActor). The backdoor exists so a fresh DB with no admin_users rows is
// still reachable by an allowlisted operator, who then seeds a real row. Its
// invariants must never silently widen:
//   * opens ONLY when admin_users is empty AND the caller is on SUPERUSER_EMAILS
//   * slams shut the instant any admin row exists (even for an allowlisted email)
//   * a disabled admin row is a hard no (never falls through to the backdoor)
// docs/decisions/D-25.md. The complementary MFA-enforcement and
// "rows exist + non-admin" cases live in admin-mfa-gate.test.ts.

const redirectMock = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const getAuthUserMock = vi.fn();
vi.mock("@/lib/auth", () => ({ getAuthUser: getAuthUserMock }));

const adminFindUnique = vi.fn();
const adminCount = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { adminUser: { findUnique: adminFindUnique, count: adminCount } },
}));

const isSuperuserMock = vi.fn();
vi.mock("@/lib/env", () => ({
  isSuperuser: (email: string | null | undefined) => isSuperuserMock(email),
}));
vi.mock("@/lib/analytics/posthog", () => ({ identifyServerUser: vi.fn() }));
const sentrySetTag = vi.fn();
vi.mock("@sentry/nextjs", () => ({ setUser: vi.fn(), setTag: sentrySetTag }));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

const { resolveAdminActor, isBootstrapActor, BOOTSTRAP_ACTOR_ID } = await import("@/lib/admin");

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUserMock.mockResolvedValue({ email: "operator@example.com" });
});

describe("admin env-allowlist bootstrap", () => {
  it("opens a synthetic superadmin when admin_users is empty AND the email is allowlisted", async () => {
    adminFindUnique.mockResolvedValue(null);
    adminCount.mockResolvedValue(0);
    isSuperuserMock.mockReturnValue(true);

    const actor = await resolveAdminActor();

    expect(actor.role).toBe("superadmin");
    expect(isBootstrapActor(actor)).toBe(true);
    expect(actor.id).toBe(BOOTSTRAP_ACTOR_ID);
    expect(redirectMock).not.toHaveBeenCalled();
    // The lingering-bootstrap signal must fire so an operator notices it.
    expect(sentrySetTag).toHaveBeenCalledWith("admin_bootstrap", "true");
  });

  it("stays shut for an empty table when the email is NOT allowlisted", async () => {
    adminFindUnique.mockResolvedValue(null);
    adminCount.mockResolvedValue(0);
    isSuperuserMock.mockReturnValue(false);

    await expect(resolveAdminActor()).rejects.toThrow("REDIRECT:/");
    expect(sentrySetTag).not.toHaveBeenCalled();
  });

  it("slams shut the instant any admin row exists, even for an allowlisted email", async () => {
    // The key anti-re-arm invariant: an allowlisted operator with no row of their
    // own must NOT get backdoor access once the table is seeded.
    adminFindUnique.mockResolvedValue(null);
    adminCount.mockResolvedValue(1);
    isSuperuserMock.mockReturnValue(true);

    await expect(resolveAdminActor()).rejects.toThrow("REDIRECT:/");
    expect(sentrySetTag).not.toHaveBeenCalled();
  });

  it("treats a disabled admin row as a hard no — never falls through to the backdoor", async () => {
    adminFindUnique.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      email: "operator@example.com",
      role: "superadmin",
      disabledAt: new Date(),
    });
    // Even with an empty count + allowlist, a disabled row short-circuits before
    // the bootstrap check, so the backdoor must not re-grant the disabled admin.
    adminCount.mockResolvedValue(0);
    isSuperuserMock.mockReturnValue(true);

    await expect(resolveAdminActor()).rejects.toThrow("REDIRECT:/");
    expect(sentrySetTag).not.toHaveBeenCalled();
  });

  it("uses the real admin row (no bootstrap) when an enabled row is present", async () => {
    adminFindUnique.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      email: "operator@example.com",
      role: "finance",
      disabledAt: null,
    });
    isSuperuserMock.mockReturnValue(true);

    const actor = await resolveAdminActor("finance");

    expect(actor.role).toBe("finance");
    expect(isBootstrapActor(actor)).toBe(false);
    expect(sentrySetTag).not.toHaveBeenCalled();
  });
});
