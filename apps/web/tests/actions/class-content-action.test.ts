import { beforeEach, describe, expect, it, vi } from "vitest";

// Lesson templates (D-46) — the only authoring surface still owned by
// app/actions/class-content.ts after the materials UI unification. Saving and
// generating class content itself moved to the unified actions in
// app/actions/library.ts (docs/features/library-materials.md); their coverage
// now lives in tests/materials/handlers-content-save.test.ts (business logic)
// and tests/actions/library-content-action.test.ts (the thin dispatch layer).

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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

const templateFindFirst = vi.fn(async () => null as { position: number } | null);
const templateCreate = vi.fn(async () => ({ id: "tpl1", label: "Warm-up", body: "# Warm-up" }));
const templateDeleteMany = vi.fn(async () => ({ count: 1 }));
const templateUpdateMany = vi.fn(async () => ({ count: 1 }));
const templateManagerList = vi.fn(async () => [{ id: "tpl1", label: "M", body: "## Hi" }]);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    classContentTemplate: {
      findFirst: templateFindFirst,
      create: templateCreate,
      deleteMany: templateDeleteMany,
      updateMany: templateUpdateMany,
      findMany: templateManagerList,
    },
    // The manager save runs inside a transaction; pass a tx stub exposing the
    // same classContentTemplate mocks so the real replace-set logic runs.
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        classContentTemplate: {
          create: templateCreate,
          updateMany: templateUpdateMany,
          deleteMany: templateDeleteMany,
          findMany: templateManagerList,
        },
      }),
  },
}));

const {
  saveClassContentTemplateAction,
  saveClassContentTemplatesAction,
  deleteClassContentTemplateAction,
} = await import("@/app/actions/class-content");

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  state.pro = true;
  templateFindFirst.mockReset().mockResolvedValue(null);
  templateCreate.mockClear().mockResolvedValue({ id: "tpl1", label: "Warm-up", body: "# Warm-up" });
  templateDeleteMany.mockClear();
  templateUpdateMany.mockClear().mockResolvedValue({ count: 1 });
  templateManagerList.mockClear().mockResolvedValue([{ id: "tpl1", label: "M", body: "## Hi" }]);
});

describe("saveClassContentTemplateAction", () => {
  it("blocks a Free teacher and never writes", async () => {
    state.pro = false;
    const r = await saveClassContentTemplateAction(
      undefined,
      fd({ label: "Warm-up", body: "# Hi" }),
    );
    expect(r).toEqual({ error: "UPGRADE" });
    expect(templateCreate).not.toHaveBeenCalled();
  });

  it("saves and returns the new template for the client to append locally", async () => {
    const r = await saveClassContentTemplateAction(
      undefined,
      fd({ label: "Warm-up", body: "# Hi" }),
    );
    expect(r).toEqual({ ok: true, template: { id: "tpl1", label: "Warm-up", body: "# Warm-up" } });
  });
});

describe("deleteClassContentTemplateAction", () => {
  it("scopes the delete to the current teacher", async () => {
    await deleteClassContentTemplateAction(fd({ templateId: "tpl1" }));
    expect(templateDeleteMany).toHaveBeenCalledWith({ where: { id: "tpl1", teacherId: "t1" } });
  });
});

describe("saveClassContentTemplatesAction (manager)", () => {
  // Build FormData with the parallel replace-set arrays the form posts.
  function managerForm(
    rows: { id?: string; label: string; body: string; keep: boolean }[],
  ): FormData {
    const f = new FormData();
    for (const r of rows) {
      f.append("tpl_id", r.id ?? "");
      f.append("tpl_label", r.label);
      f.append("tpl_body", r.body);
      f.append("tpl_keep", r.keep ? "1" : "0");
    }
    return f;
  }

  it("parses the parallel arrays into create / edit / delete", async () => {
    const r = await saveClassContentTemplatesAction(
      undefined,
      managerForm([
        { id: "a", label: "A renamed", body: "## A2", keep: true }, // edit
        { id: "", label: "New", body: "## New", keep: true }, // create
        { id: "b", label: "B", body: "## B", keep: false }, // delete
      ]),
    );
    expect(r?.ok).toBe(true);
    expect(templateUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "a", teacherId: "t1" },
        data: expect.objectContaining({ label: "A renamed", body: "## A2", position: 0 }),
      }),
    );
    expect(templateCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          teacherId: "t1",
          label: "New",
          body: "## New",
          position: 1,
        }),
      }),
    );
    expect(templateDeleteMany).toHaveBeenCalledWith({ where: { id: "b", teacherId: "t1" } });
  });

  it("blocks a Free teacher and writes nothing", async () => {
    state.pro = false;
    const r = await saveClassContentTemplatesAction(
      undefined,
      managerForm([{ id: "", label: "M", body: "## Hi", keep: true }]),
    );
    expect(r).toEqual({ error: "UPGRADE" });
    expect(templateCreate).not.toHaveBeenCalled();
  });
});
