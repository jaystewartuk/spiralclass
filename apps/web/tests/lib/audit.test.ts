import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// writeOverride is the write side of the admin audit trail — every admin
// mutation records one row here. Action-layer tests only ever MOCK it, so its
// own branches have never been directly exercised. The security-relevant one:
// a bootstrap superadmin (env-allowlist actor, no admin_users row yet) must
// collapse to a NULL actorAdminId rather than forge an FK, so the action still
// logs but stays honestly unattributed. Also: teacher-initiated (null actor) →
// null, an explicit tx client is honored, and missing before/after become
// Prisma.JsonNull (not undefined) so the JSON columns are written explicitly.

const BOOTSTRAP_ACTOR_ID = "00000000-0000-0000-0000-000000000000";
vi.mock("@/lib/admin", () => ({ BOOTSTRAP_ACTOR_ID }));

const create = vi.fn(async () => ({ id: "ovr-1" }));
vi.mock("@/lib/prisma", () => ({ prisma: { override: { create } } }));

const info = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: () => ({ info }) }));

const { writeOverride } = await import("@/lib/audit");

const base = {
  teacherId: "tch-1",
  targetType: "payment" as const,
  targetId: "pay-1",
  action: "refund",
  reason: "duplicate charge",
  actor: { id: "adm-1", email: "a@x.com", role: "finance" as const },
};

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ id: "ovr-1" });
});

function dataOf(call = 0) {
  const args = create.mock.calls[call] as unknown as [{ data: Record<string, unknown> }];
  return args[0].data;
}

describe("writeOverride — actor attribution", () => {
  it("passes a real admin id through as actorAdminId", async () => {
    await writeOverride(base);
    expect(dataOf().actorAdminId).toBe("adm-1");
  });

  it("collapses the bootstrap actor to a NULL actorAdminId (unattributed, no forged FK)", async () => {
    await writeOverride({ ...base, actor: { ...base.actor, id: BOOTSTRAP_ACTOR_ID } });
    expect(dataOf().actorAdminId).toBeNull();
  });

  it("records a teacher-initiated (null actor) override as unattributed", async () => {
    await writeOverride({ ...base, actor: null });
    expect(dataOf().actorAdminId).toBeNull();
  });
});

describe("writeOverride — payload", () => {
  it("writes undefined before/after as Prisma.JsonNull, not undefined", async () => {
    await writeOverride(base);
    expect(dataOf().beforeJson).toBe(Prisma.JsonNull);
    expect(dataOf().afterJson).toBe(Prisma.JsonNull);
  });

  it("passes explicit before/after snapshots through", async () => {
    await writeOverride({ ...base, before: { status: "paid" }, after: { status: "refunded" } });
    expect(dataOf().beforeJson).toEqual({ status: "paid" });
    expect(dataOf().afterJson).toEqual({ status: "refunded" });
  });

  it("records a platform-scoped override with a null teacherId", async () => {
    await writeOverride({ ...base, teacherId: null });
    expect(dataOf().teacherId).toBeNull();
  });

  it("returns the created row id", async () => {
    create.mockResolvedValueOnce({ id: "ovr-42" });
    await expect(writeOverride(base)).resolves.toBe("ovr-42");
  });
});

describe("writeOverride — transaction + logging", () => {
  it("honors an explicit tx client instead of the top-level prisma", async () => {
    const txCreate = vi.fn(async () => ({ id: "ovr-tx" }));
    const tx = { override: { create: txCreate } } as never;
    const id = await writeOverride({ ...base, tx });
    expect(id).toBe("ovr-tx");
    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("emits the out-of-band audit log copy with the resolved actor id", async () => {
    await writeOverride({ ...base, actor: { ...base.actor, id: BOOTSTRAP_ACTOR_ID } });
    expect(info).toHaveBeenCalledWith(
      "override",
      expect.objectContaining({ overrideId: "ovr-1", action: "refund", actorAdminId: null }),
    );
  });
});
