import { beforeEach, describe, expect, it, vi } from "vitest";

// Reusable lesson skeletons (task 3): Pro gate on save, label/body
// validation, position assignment, and tenant-scoped delete.

const state = { pro: true };
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: vi.fn(async () =>
    state.pro ? { ok: true } : { ok: false, limit: "class_content" },
  ),
  upgradeNudge: vi.fn(() => "UPGRADE"),
}));

const findFirst = vi.fn();
const create = vi.fn();
const findMany = vi.fn();
const deleteMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    classContentTemplate: {
      findFirst: (...args: unknown[]) => findFirst(...args),
      create: (...args: unknown[]) => create(...args),
      findMany: (...args: unknown[]) => findMany(...args),
      deleteMany: (...args: unknown[]) => deleteMany(...args),
    },
  },
}));

const { listClassContentTemplates, saveClassContentTemplate, deleteClassContentTemplate } =
  await import("@/lib/materials/templates");

beforeEach(() => {
  state.pro = true;
  findFirst.mockReset().mockResolvedValue(null);
  create.mockReset().mockResolvedValue({ id: "tpl1", label: "Warm-up", body: "# Warm-up" });
  findMany.mockReset().mockResolvedValue([]);
  deleteMany.mockReset().mockResolvedValue({ count: 1 });
});

describe("saveClassContentTemplate", () => {
  it("blocks a Free teacher with the upgrade nudge and never writes", async () => {
    state.pro = false;
    const r = await saveClassContentTemplate({
      teacherId: "t1",
      label: "Warm-up",
      body: "# Hi",
      locale: "en",
    });
    expect(r).toEqual({ ok: false, code: "not-pro", message: "UPGRADE" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an empty body", async () => {
    const r = await saveClassContentTemplate({
      teacherId: "t1",
      label: "Warm-up",
      body: "   ",
      locale: "en",
    });
    expect(r.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a blank label", async () => {
    const r = await saveClassContentTemplate({
      teacherId: "t1",
      label: "   ",
      body: "# Hi",
      locale: "en",
    });
    expect(r.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("trims the label and appends to the end of the teacher's list", async () => {
    findFirst.mockResolvedValue({ position: 2 });
    await saveClassContentTemplate({
      teacherId: "t1",
      label: "  Warm-up  ",
      body: "  # Hi  ",
      locale: "en",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { teacherId: "t1", label: "Warm-up", body: "# Hi", position: 3 },
      }),
    );
  });

  it("starts position at 0 for a teacher's first template", async () => {
    findFirst.mockResolvedValue(null);
    await saveClassContentTemplate({ teacherId: "t1", label: "A", body: "# Hi", locale: "en" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ position: 0 }) }),
    );
  });
});

describe("listClassContentTemplates", () => {
  it("scopes by teacherId, ordered by position then createdAt", async () => {
    await listClassContentTemplates("t1");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teacherId: "t1" },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      }),
    );
  });
});

describe("deleteClassContentTemplate", () => {
  it("scopes the delete to the owning teacher", async () => {
    await deleteClassContentTemplate({ teacherId: "t1", templateId: "tpl1" });
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "tpl1", teacherId: "t1" } });
  });
});
