import { beforeEach, describe, expect, it, vi } from "vitest";

const PKG_ID = "11111111-1111-4111-8111-111111111111";
const TEACHER_ID = "22222222-2222-4222-8222-222222222222";

type PkgRow = { id: string; status: string; teacherId: string; expiresAt: Date | null };
type OverrideRow = {
  teacherId: string;
  targetType: string;
  targetId: string;
  action: string;
  reason: string;
  beforeJson: unknown;
  afterJson: unknown;
};

const state: { pkg: PkgRow | null; overrides: OverrideRow[] } = {
  pkg: null,
  overrides: [],
};

function freshState(overrides: Partial<PkgRow> = {}) {
  state.pkg = {
    id: PKG_ID,
    status: "active",
    teacherId: TEACHER_ID,
    expiresAt: new Date("2026-12-31T00:00:00Z"),
    ...overrides,
  };
  state.overrides = [];
}

const revalidatePathMock = vi.fn();

vi.mock("@/lib/admin", () => ({
  BOOTSTRAP_ACTOR_ID: "00000000-0000-0000-0000-000000000000",
  requireAdmin: vi.fn(async () => ({
    id: "admin-1",
    email: "a@b.co",
    role: "support",
  })),
  isBootstrapActor: (a: { id: string }) => a.id === "00000000-0000-0000-0000-000000000000",
}));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

vi.mock("@/lib/prisma", async () => {
  const { Prisma } = await import("@prisma/client");
  const tx = {
    package: {
      update: async ({ where, data }: { where: { id: string }; data: Partial<PkgRow> }) => {
        if (!state.pkg || where.id !== state.pkg.id) throw new Error("missing");
        Object.assign(state.pkg, data);
        return state.pkg;
      },
    },
    override: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.overrides.push({
          ...(data as unknown as OverrideRow),
          beforeJson: (data.beforeJson as unknown) === Prisma.JsonNull ? null : data.beforeJson,
          afterJson: (data.afterJson as unknown) === Prisma.JsonNull ? null : data.afterJson,
        });
        return { id: `o-${state.overrides.length}` };
      },
    },
  };
  return {
    prisma: {
      package: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          state.pkg && where.id === state.pkg.id ? { ...state.pkg } : null,
      },
      $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
  };
});

const { cancelPackageAction, extendPackageExpirationAction } =
  await import("@/app/actions/admin-packages");

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  revalidatePathMock.mockClear();
});

describe("cancelPackageAction", () => {
  it("flips active → refunded and writes an Override", async () => {
    freshState({ status: "active" });
    const res = await cancelPackageAction(
      undefined,
      form({ packageId: PKG_ID, reason: "teacher off-boarded" }),
    );
    expect(res).toEqual({ ok: true });
    expect(state.pkg?.status).toBe("refunded");
    expect(state.overrides).toHaveLength(1);
    expect(state.overrides[0]).toMatchObject({
      teacherId: TEACHER_ID,
      targetType: "package",
      targetId: PKG_ID,
      action: "cancel_package",
      reason: "teacher off-boarded",
    });
  });

  it("refuses to cancel an already-refunded package", async () => {
    freshState({ status: "refunded" });
    const res = await cancelPackageAction(undefined, form({ packageId: PKG_ID, reason: "x" }));
    expect(res?.error).toBe("Ya está cancelado");
    expect(state.overrides).toHaveLength(0);
  });
});

describe("extendPackageExpirationAction", () => {
  it("pushes expiry forward by N months", async () => {
    freshState({ expiresAt: new Date("2026-06-15T00:00:00Z") });
    const res = await extendPackageExpirationAction(
      undefined,
      form({ packageId: PKG_ID, months: "3", reason: "platform outage" }),
    );
    expect(res).toEqual({ ok: true });
    expect(state.pkg?.expiresAt?.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(state.overrides).toHaveLength(1);
    expect(state.overrides[0]).toMatchObject({
      targetType: "package",
      action: "extend_expiration",
    });
  });

  it("refuses to extend a package with no expiry", async () => {
    freshState({ expiresAt: null });
    const res = await extendPackageExpirationAction(
      undefined,
      form({ packageId: PKG_ID, months: "3", reason: "x" }),
    );
    expect(res?.error).toMatch(/no expira/);
    expect(state.overrides).toHaveLength(0);
  });
});
