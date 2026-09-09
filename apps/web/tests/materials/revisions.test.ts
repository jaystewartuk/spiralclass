import { beforeEach, describe, expect, it, vi } from "vitest";

// Version-history storage (task 5, generalized to any material at D-69):
// snapshot + prune + list. Exercised directly against a hand-rolled fake db
// (mirrors the focus-tags.test.ts style) rather than through the save
// action, so the cap/prune behavior is pinned independent of the save-path
// wiring.

const create = vi.fn();
const findMany = vi.fn();
const deleteMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    materialRevision: {
      create: (...args: unknown[]) => create(...args),
      findMany: (...args: unknown[]) => findMany(...args),
      deleteMany: (...args: unknown[]) => deleteMany(...args),
    },
  },
}));

const { snapshotMaterialRevision, listMaterialRevisions } =
  await import("@/lib/materials/revisions");

beforeEach(() => {
  create.mockReset().mockResolvedValue({});
  findMany.mockReset().mockResolvedValue([]);
  deleteMany.mockReset().mockResolvedValue({ count: 0 });
});

describe("snapshotMaterialRevision", () => {
  it("creates a row with the outgoing body/source", async () => {
    await snapshotMaterialRevision({
      teacherId: "t1",
      materialId: "m1",
      body: "# Old",
      source: "manual",
    });
    expect(create).toHaveBeenCalledWith({
      data: { materialId: "m1", teacherId: "t1", body: "# Old", source: "manual" },
    });
  });

  it("prunes rows past the cap, oldest first", async () => {
    findMany.mockResolvedValue([{ id: "r21" }, { id: "r22" }]);
    await snapshotMaterialRevision({
      teacherId: "t1",
      materialId: "m1",
      body: "# Old",
      source: "manual",
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { materialId: "m1" },
        orderBy: { createdAt: "desc" },
        skip: 20,
      }),
    );
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["r21", "r22"] } } });
  });

  it("skips the prune query when nothing is past the cap", async () => {
    findMany.mockResolvedValue([]);
    await snapshotMaterialRevision({
      teacherId: "t1",
      materialId: "m1",
      body: "# Old",
      source: "manual",
    });
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe("listMaterialRevisions", () => {
  it("scopes by teacher and material, most-recent-first", async () => {
    findMany.mockResolvedValue([
      { id: "r2", body: "# B", source: "ai", createdAt: new Date("2026-01-02") },
      { id: "r1", body: "# A", source: "manual", createdAt: new Date("2026-01-01") },
    ]);
    const rows = await listMaterialRevisions({ teacherId: "t1", materialId: "m1" });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teacherId: "t1", materialId: "m1" },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(["r2", "r1"]);
  });
});
