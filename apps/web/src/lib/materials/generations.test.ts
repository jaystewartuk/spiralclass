import { beforeEach, describe, expect, it, vi } from "vitest";

// D-202: each AI materials call records what came back and whether a save
// kept it, and the text is cleared after 30 days.

const create = vi.fn(async (..._: unknown[]) => ({}));
const findMany = vi.fn(async (..._: unknown[]) => [] as { id: string; body: string | null }[]);
const updateMany = vi.fn(async (..._: unknown[]) => ({ count: 0 }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    classContentGeneration: {
      create: (...a: unknown[]) => create(...a),
      findMany: (...a: unknown[]) => findMany(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
    },
  },
}));

const {
  GENERATION_BODY_RETENTION_DAYS,
  markKeptGenerations,
  purgeExpiredGenerationBodies,
  recordMaterialGeneration,
  savedBodyContains,
} = await import("./generations");

const NOW = new Date("2026-10-16T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  updateMany.mockImplementation(async (arg: unknown) => ({
    count: ((arg as { where: { id?: { in: string[] } } }).where.id?.in ?? []).length,
  }));
});

describe("recordMaterialGeneration", () => {
  it("writes the quota row with the kind, the output and the instruction", async () => {
    await recordMaterialGeneration({
      teacherId: "t1",
      kind: "refine",
      body: "  # Lesson\n",
      instruction: " shorter, fewer exercises ",
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        teacherId: "t1",
        kind: "refine",
        body: "# Lesson",
        instruction: "shorter, fewer exercises",
      },
    });
  });

  it("stores no text for a podcast script", async () => {
    await recordMaterialGeneration({ teacherId: "t1", kind: "podcast_script" });
    expect(create).toHaveBeenCalledWith({
      data: { teacherId: "t1", kind: "podcast_script", body: null, instruction: null },
    });
  });
});

describe("savedBodyContains", () => {
  it("matches a whole-document generation and a section spliced into a longer body", () => {
    expect(savedBodyContains("# A\n\nBody", "# A\n\nBody")).toBe(true);
    expect(savedBodyContains("# A\n\n## Warm-up\nHola\n\n## End", "## Warm-up\nHola")).toBe(true);
  });

  it("ignores line-ending and edge whitespace differences", () => {
    expect(savedBodyContains("# A\n\nBody\n", "  # A\r\n\r\nBody ")).toBe(true);
  });

  it("does not match a body the teacher changed, or an empty generation", () => {
    expect(savedBodyContains("# A\n\nBody, edited", "# A\n\nBody text")).toBe(false);
    expect(savedBodyContains("anything", "   ")).toBe(false);
  });
});

describe("markKeptGenerations", () => {
  it("marks every recent unkept generation the saved body contains, and only those", async () => {
    findMany.mockResolvedValue([
      { id: "g-whole", body: "# A\n\n## Warm-up\nHola" },
      { id: "g-section", body: "## Warm-up\nHola" },
      { id: "g-discarded", body: "# Something else" },
    ]);
    const n = await markKeptGenerations({
      teacherId: "t1",
      materialId: "m1",
      savedBody: "# A\n\n## Warm-up\nHola",
      now: NOW,
    });
    expect(n).toBe(2);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        teacherId: "t1",
        keptAt: null,
        body: { not: null },
        createdAt: { gte: new Date("2026-10-15T12:00:00.000Z") },
      },
      select: { id: true, body: true },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["g-whole", "g-section"] }, teacherId: "t1" },
      data: { keptAt: NOW, materialId: "m1" },
    });
  });

  it("writes nothing when no generation matches", async () => {
    findMany.mockResolvedValue([{ id: "g1", body: "# Other" }]);
    expect(
      await markKeptGenerations({ teacherId: "t1", materialId: "m1", savedBody: "# Mine" }),
    ).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("never fails the save it is called from", async () => {
    findMany.mockRejectedValue(new Error("db down"));
    await expect(
      markKeptGenerations({ teacherId: "t1", materialId: "m1", savedBody: "# A" }),
    ).resolves.toBe(0);
  });
});

describe("purgeExpiredGenerationBodies", () => {
  it("clears text older than the retention window and keeps the rows", async () => {
    const db = { classContentGeneration: { updateMany: vi.fn(async () => ({ count: 4 })) } };
    expect(await purgeExpiredGenerationBodies(db as never, NOW)).toBe(4);
    const cutoff = new Date(NOW.getTime() - GENERATION_BODY_RETENTION_DAYS * 86_400_000);
    expect(db.classContentGeneration.updateMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: cutoff },
        OR: [{ body: { not: null } }, { instruction: { not: null } }],
      },
      data: { body: null, instruction: null },
    });
  });
});
