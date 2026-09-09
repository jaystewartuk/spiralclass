import { beforeEach, describe, expect, it, vi } from "vitest";

// Teacher-editable focus tags + categories (D-20 deferred follow-up;
// category later moved from free text into its own manageable
// taxonomy). Covered here: the Pro gate, FormData → row parsing
// (create/archive), and validation — the actual seed/read/group logic is
// exercised in tests/lib/focus-tags.test.ts.

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "en") }));

const state = { pro: true };
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: vi.fn(async () =>
    state.pro ? { ok: true } : { ok: false, limit: "class_content" },
  ),
  upgradeNudge: vi.fn(() => "UPGRADE"),
}));

const tagCreate = vi.fn(async ({ data }: any) => ({ id: "new1", ...data }));
const tagUpdateMany = vi.fn(async () => ({ count: 1 }));
const tagFindMany = vi.fn(async () => [] as any[]);
const tagGroupBy = vi.fn(async () => [] as any[]);
const focusTag = {
  create: tagCreate,
  updateMany: tagUpdateMany,
  findMany: tagFindMany,
  groupBy: tagGroupBy,
};

const categoryCreate = vi.fn(async ({ data }: any) => ({ id: "newcat1", ...data }));
const categoryUpdateMany = vi.fn(async () => ({ count: 1 }));
// Every posted categoryId is valid by default — individual tests override this.
const categoryFindMany = vi.fn(async () => [{ id: "cat-1" }] as any[]);
const categoryFindUnique = vi.fn(async () => ({ id: "cat-1", label: "Grammar" }) as any);
const focusTagCategory = {
  create: categoryCreate,
  updateMany: categoryUpdateMany,
  findMany: categoryFindMany,
  findUnique: categoryFindUnique,
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    focusTag,
    focusTagCategory,
    $transaction: vi.fn(
      async (
        cb: (tx: {
          focusTag: typeof focusTag;
          focusTagCategory: typeof focusTagCategory;
        }) => unknown,
      ) => cb({ focusTag, focusTagCategory }),
    ),
  },
}));

const { saveFocusCategoriesAction, saveFocusTagsAction } = await import("@/app/actions/focus-tags");

function tagFd(
  rows: { id?: string; label: string; categoryId: string; keep: boolean }[],
): FormData {
  const f = new FormData();
  for (const r of rows) {
    f.append("tag_id", r.id ?? "");
    f.append("tag_label", r.label);
    f.append("tag_category_id", r.categoryId);
    f.append("tag_keep", r.keep ? "1" : "0");
  }
  return f;
}

function categoryFd(rows: { id?: string; label: string; keep: boolean }[]): FormData {
  const f = new FormData();
  for (const r of rows) {
    f.append("category_id", r.id ?? "");
    f.append("category_label", r.label);
    f.append("category_keep", r.keep ? "1" : "0");
  }
  return f;
}

beforeEach(() => {
  state.pro = true;
  tagCreate.mockClear();
  tagUpdateMany.mockClear();
  tagFindMany.mockReset().mockResolvedValue([]);
  tagGroupBy.mockReset().mockResolvedValue([]);
  categoryCreate.mockClear();
  categoryUpdateMany.mockClear();
  categoryFindMany.mockReset().mockResolvedValue([{ id: "cat-1" }]);
  categoryFindUnique.mockReset().mockResolvedValue({ id: "cat-1", label: "Grammar" });
});

describe("saveFocusTagsAction", () => {
  it("blocks a Free teacher with the upgrade nudge and never writes", async () => {
    state.pro = false;
    const r = await saveFocusTagsAction(
      undefined,
      tagFd([{ label: "New", categoryId: "cat-1", keep: true }]),
    );
    expect(r).toEqual({ error: "UPGRADE" });
    expect(tagCreate).not.toHaveBeenCalled();
  });

  it("creates a new row from an id-less kept form row", async () => {
    const r = await saveFocusTagsAction(
      undefined,
      tagFd([{ label: "New topic", categoryId: "cat-1", keep: true }]),
    );
    expect(r?.ok).toBe(true);
    expect(tagCreate).toHaveBeenCalledTimes(1);
    const arg = (tagCreate.mock.calls as any)[0][0];
    expect(arg.data).toMatchObject({ teacherId: "t1", label: "New topic", categoryId: "cat-1" });
  });

  it("archives an existing row flagged as not kept, scoped to the teacher", async () => {
    const r = await saveFocusTagsAction(
      undefined,
      tagFd([{ id: "a1", label: "Presente", categoryId: "cat-1", keep: false }]),
    );
    expect(r?.ok).toBe(true);
    expect(tagUpdateMany).toHaveBeenCalledWith({
      where: { id: "a1", teacherId: "t1" },
      data: { archived: true },
    });
    expect(tagCreate).not.toHaveBeenCalled();
  });

  it("renames an existing kept row", async () => {
    const r = await saveFocusTagsAction(
      undefined,
      tagFd([{ id: "a1", label: "Presente (updated)", categoryId: "cat-1", keep: true }]),
    );
    expect(r?.ok).toBe(true);
    expect(tagUpdateMany).toHaveBeenCalledWith({
      where: { id: "a1", teacherId: "t1" },
      data: { label: "Presente (updated)", categoryId: "cat-1", position: 0, archived: false },
    });
  });

  it("rejects a blank label and writes nothing", async () => {
    const r = await saveFocusTagsAction(
      undefined,
      tagFd([{ label: "  ", categoryId: "cat-1", keep: true }]),
    );
    expect(r?.error).toBeTruthy();
    expect(tagCreate).not.toHaveBeenCalled();
    expect(tagUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects a categoryId that isn't one of the teacher's own active categories", async () => {
    categoryFindMany.mockResolvedValue([]);
    const r = await saveFocusTagsAction(
      undefined,
      tagFd([{ label: "New", categoryId: "not-mine", keep: true }]),
    );
    expect(r?.error).toBeTruthy();
    expect(tagCreate).not.toHaveBeenCalled();
  });
});

describe("saveFocusCategoriesAction", () => {
  it("blocks a Free teacher with the upgrade nudge and never writes", async () => {
    state.pro = false;
    const r = await saveFocusCategoriesAction(
      undefined,
      categoryFd([{ label: "New", keep: true }]),
    );
    expect(r).toEqual({ error: "UPGRADE" });
    expect(categoryCreate).not.toHaveBeenCalled();
  });

  it("creates a new row from an id-less kept form row", async () => {
    const r = await saveFocusCategoriesAction(
      undefined,
      categoryFd([{ label: "Pronunciation", keep: true }]),
    );
    expect(r?.ok).toBe(true);
    expect(categoryCreate).toHaveBeenCalledTimes(1);
    const arg = (categoryCreate.mock.calls as any)[0][0];
    expect(arg.data).toMatchObject({ teacherId: "t1", label: "Pronunciation" });
  });

  it("archives an existing row flagged as not kept when it has no active tags", async () => {
    const r = await saveFocusCategoriesAction(
      undefined,
      categoryFd([{ id: "cat-1", label: "Grammar", keep: false }]),
    );
    expect(r?.ok).toBe(true);
    expect(categoryUpdateMany).toHaveBeenCalledWith({
      where: { id: "cat-1", teacherId: "t1" },
      data: { archived: true },
    });
  });

  it("rejects deleting a category that still has active focus tags", async () => {
    tagGroupBy.mockResolvedValue([{ categoryId: "cat-1", _count: { _all: 3 } }]);
    categoryFindMany.mockResolvedValue([{ id: "cat-1", label: "Grammar" }]);
    const r = await saveFocusCategoriesAction(
      undefined,
      categoryFd([{ id: "cat-1", label: "Grammar", keep: false }]),
    );
    expect(r?.error).toContain("Grammar");
    expect(r?.error).toContain("3");
    expect(categoryUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects a blank label and writes nothing", async () => {
    const r = await saveFocusCategoriesAction(
      undefined,
      categoryFd([{ label: "   ", keep: true }]),
    );
    expect(r?.error).toBeTruthy();
    expect(categoryCreate).not.toHaveBeenCalled();
  });
});
