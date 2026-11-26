import { beforeEach, describe, expect, it, vi } from "vitest";

// Version-history storage (task 5, generalized to any material):
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

const { snapshotMaterialRevision, listMaterialRevisions, listRevisionSummariesForMaterials } =
  await import("@/lib/materials/revisions");
const { REVISIONS_SHOWN, REVISION_PREVIEW_CHARS } =
  await import("@/lib/materials/revision-summary");

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
        where: { teacherId: "t1", materialId: "m1" },
        orderBy: { createdAt: "desc" },
        skip: 20,
      }),
    );
    expect(deleteMany).toHaveBeenCalledWith({
      where: { teacherId: "t1", id: { in: ["r21", "r22"] } },
    });
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

describe("listRevisionSummariesForMaterials", () => {
  const at = (d: number) => new Date(Date.UTC(2026, 0, d));

  it("reads every row's history in one query, scoped to the teacher", async () => {
    await listRevisionSummariesForMaterials({ teacherId: "t1", materialIds: ["m1", "m2", "m3"] });
    // One round trip for the whole shelf — not one (or two) per row.
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teacherId: "t1", materialId: { in: ["m1", "m2", "m3"] } },
        orderBy: { createdAt: "desc" },
      }),
    );
  });

  it("makes no query for a page with no body-bearing rows", async () => {
    const map = await listRevisionSummariesForMaterials({ teacherId: "t1", materialIds: [] });
    expect(findMany).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it("groups by material, keeps order, and ships a snippet instead of the body", async () => {
    const long = `# Título\n\n${"palabra ".repeat(500)}`;
    findMany.mockResolvedValue([
      { id: "a2", materialId: "m1", body: long, source: "ai", createdAt: at(3) },
      { id: "b1", materialId: "m2", body: "  ", source: "manual", createdAt: at(2) },
      { id: "a1", materialId: "m1", body: "# Old", source: "manual", createdAt: at(1) },
    ]);
    const map = await listRevisionSummariesForMaterials({
      teacherId: "t1",
      materialIds: ["m1", "m2"],
    });
    expect(map.get("m1")!.map((r) => r.id)).toEqual(["a2", "a1"]);
    expect(map.get("m1")![0]).toEqual({
      id: "a2",
      source: "ai",
      createdAt: at(3),
      preview: long.replace(/\s+/g, " ").trim().slice(0, REVISION_PREVIEW_CHARS),
    });
    expect(map.get("m1")![0]).not.toHaveProperty("body");
    expect(map.get("m2")![0]!.preview).toBe("");
  });

  it("caps each material at the number the editor lists", async () => {
    findMany.mockResolvedValue(
      Array.from({ length: REVISIONS_SHOWN + 5 }, (_, i) => ({
        id: `r${i}`,
        materialId: "m1",
        body: "x",
        source: "manual",
        createdAt: at(28 - i),
      })),
    );
    const map = await listRevisionSummariesForMaterials({ teacherId: "t1", materialIds: ["m1"] });
    expect(map.get("m1")).toHaveLength(REVISIONS_SHOWN);
    expect(map.get("m1")![0]!.id).toBe("r0");
  });
});
