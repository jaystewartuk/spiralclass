import { beforeEach, describe, expect, it, vi } from "vitest";

// Admin staff management. All three actions require the superadmin role. The
// security-relevant guards beyond that: duplicate-email handling on invite,
// the self-protection rules (a non-bootstrap admin can't demote or disable
// their own account), and the last-active-superadmin guard (the platform can
// never be left with zero active superadmins).

const state = { actor: { id: "admin1", role: "superadmin", bootstrap: false } };

vi.mock("@/lib/admin", () => ({
  requireAdmin: vi.fn(async () => state.actor),
  isBootstrapActor: (a: { bootstrap?: boolean }) => Boolean(a.bootstrap),
}));

const adminCreate = vi.fn(async (_arg: { data: Record<string, unknown> }) => ({ id: "new" }));
const adminUpdate = vi.fn(async (_arg: { data: Record<string, unknown> }) => ({}));
// Default: the target is a plain support admin and other active superadmins
// exist, so neither the superadmin-target nor the last-superadmin guard fires.
const adminFindUnique = vi.fn(
  async (_arg: unknown): Promise<{ role: string; disabledAt: Date | null } | null> => ({
    role: "support",
    disabledAt: null,
  }),
);
const adminCount = vi.fn(async (_arg: unknown) => 1);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    adminUser: {
      create: adminCreate,
      update: adminUpdate,
      findUnique: adminFindUnique,
      count: adminCount,
    },
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { inviteAdminAction, updateAdminRoleAction, toggleAdminDisabledAction } =
  await import("@/app/actions/admin-staff");

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

const ADMIN_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  state.actor = { id: "admin1", role: "superadmin", bootstrap: false };
  adminFindUnique.mockResolvedValue({ role: "support", disabledAt: null });
  adminCount.mockResolvedValue(1);
});

describe("inviteAdminAction", () => {
  it("rejects an invalid email/role", async () => {
    expect(
      await inviteAdminAction(undefined, form({ email: "x", role: "support" })),
    ).toHaveProperty("error");
    expect(adminCreate).not.toHaveBeenCalled();
  });

  it("creates a new admin (lowercased email)", async () => {
    const res = await inviteAdminAction(undefined, form({ email: "New@X.com", role: "finance" }));
    expect(res).toEqual({ ok: true });
    const data = adminCreate.mock.calls[0][0].data as { email: string };
    expect(data.email).toBe("new@x.com");
  });

  it("maps a duplicate-email (P2002) to a friendly error", async () => {
    adminCreate.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(
      await inviteAdminAction(undefined, form({ email: "dup@x.com", role: "support" })),
    ).toHaveProperty("error");
  });
});

describe("updateAdminRoleAction", () => {
  it("refuses to let a non-bootstrap admin demote themselves", async () => {
    const res = await updateAdminRoleAction(
      undefined,
      form({ adminId: "admin1", role: "support" }),
    );
    expect(res).toHaveProperty("error");
    expect(adminUpdate).not.toHaveBeenCalled();
  });

  it("updates another admin's role", async () => {
    const res = await updateAdminRoleAction(
      undefined,
      form({ adminId: ADMIN_ID, role: "finance" }),
    );
    expect(res).toEqual({ ok: true });
    expect(adminUpdate).toHaveBeenCalled();
  });

  it("refuses to demote the last active superadmin", async () => {
    adminFindUnique.mockResolvedValueOnce({ role: "superadmin", disabledAt: null });
    adminCount.mockResolvedValueOnce(0); // no other active superadmins
    const res = await updateAdminRoleAction(
      undefined,
      form({ adminId: ADMIN_ID, role: "support" }),
    );
    expect(res).toHaveProperty("error");
    expect(adminUpdate).not.toHaveBeenCalled();
  });

  it("allows demoting a superadmin when others remain", async () => {
    adminFindUnique.mockResolvedValueOnce({ role: "superadmin", disabledAt: null });
    adminCount.mockResolvedValueOnce(2); // other active superadmins exist
    const res = await updateAdminRoleAction(
      undefined,
      form({ adminId: ADMIN_ID, role: "finance" }),
    );
    expect(res).toEqual({ ok: true });
    expect(adminUpdate).toHaveBeenCalled();
  });
});

describe("toggleAdminDisabledAction", () => {
  it("refuses to let a non-bootstrap admin disable themselves", async () => {
    const res = await toggleAdminDisabledAction(
      undefined,
      form({ adminId: "admin1", disable: "true" }),
    );
    expect(res).toHaveProperty("error");
    expect(adminUpdate).not.toHaveBeenCalled();
  });

  it("disables another admin", async () => {
    const res = await toggleAdminDisabledAction(
      undefined,
      form({ adminId: ADMIN_ID, disable: "true" }),
    );
    expect(res).toEqual({ ok: true });
    const data = adminUpdate.mock.calls[0][0].data as { disabledAt: Date | null };
    expect(data.disabledAt).toBeInstanceOf(Date);
  });

  it("refuses to disable the last active superadmin", async () => {
    adminFindUnique.mockResolvedValueOnce({ role: "superadmin", disabledAt: null });
    adminCount.mockResolvedValueOnce(0);
    const res = await toggleAdminDisabledAction(
      undefined,
      form({ adminId: ADMIN_ID, disable: "true" }),
    );
    expect(res).toHaveProperty("error");
    expect(adminUpdate).not.toHaveBeenCalled();
  });

  it("re-enables another admin (disabledAt cleared)", async () => {
    await toggleAdminDisabledAction(undefined, form({ adminId: ADMIN_ID, disable: "false" }));
    const data = adminUpdate.mock.calls[0][0].data as { disabledAt: Date | null };
    expect(data.disabledAt).toBeNull();
  });
});
