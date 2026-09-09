import { describe, expect, it, vi, beforeEach } from "vitest";

const state = { pro: true };
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: vi.fn(async () =>
    state.pro ? { ok: true } : { ok: false, limit: "class_content" },
  ),
  upgradeNudge: vi.fn(() => "UPGRADE"),
}));

import {
  ensureTeacherFocusCategories,
  ensureTeacherFocusTags,
  getTeacherFocusCategories,
  getTeacherFocusGroups,
  getTeacherFocusTags,
  resolveFocusTagLabels,
  resolveFocusTagsWithCategory,
  resolveOwnedFocusTagIds,
  saveFocusCategoriesForTeacher,
  saveFocusTagsForTeacher,
} from "@/lib/focus-tags";
import { focusTagSeedFor, FOCUS_TAG_BUILTIN_CATEGORIES, FORMAT_TAG_SEEDS } from "@/lib/focus-packs";

// focus-tags.ts logic — D-19 Layer 2 (category became its own
// manageable taxonomy instead of a free-text/fixed-enum field). The DB
// helpers take an injectable `db`, so we exercise the seeding/offset/resolve
// logic with a hand-rolled fake (mirrors how levels are integration-tested,
// but pure here).

type FakeCategoryRow = {
  id: string;
  code: string;
  label: string;
  position: number;
  archived?: boolean;
  teacherId?: string;
};

type FakeTagRow = {
  id: string;
  code: string;
  label: string;
  categoryId: string;
  position: number;
  archived?: boolean;
  teacherId?: string;
};

function fakeDb(initialTags: FakeTagRow[] = [], initialCategories: FakeCategoryRow[] = []) {
  const tagRows = [...initialTags];
  const categoryRows = [...initialCategories];
  let nextTagId = tagRows.length;
  let nextCategoryId = categoryRows.length;

  return {
    tagRows,
    categoryRows,
    focusTag: {
      aggregate: vi.fn(async ({ where }: { where: { teacherId: string } }) => {
        const rows = tagRows.filter((r) => (r.teacherId ?? "t1") === where.teacherId);
        return {
          _max: { position: rows.length ? Math.max(...rows.map((r) => r.position)) : null },
        };
      }),
      createMany: vi.fn(async ({ data }: { data: Omit<FakeTagRow, "id">[] }) => {
        let count = 0;
        for (const d of data) {
          if (
            !tagRows.some(
              (r) => r.code === d.code && (r.teacherId ?? "t1") === (d.teacherId ?? "t1"),
            )
          ) {
            tagRows.push({ id: `id-${nextTagId++}`, ...d });
            count++;
          }
        }
        return { count };
      }),
      create: vi.fn(async ({ data }: { data: Omit<FakeTagRow, "id"> }) => {
        const row = { id: `new-${nextTagId++}`, archived: false, ...data };
        tagRows.push(row);
        return row;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; teacherId: string };
          data: Partial<FakeTagRow>;
        }) => {
          let count = 0;
          for (const r of tagRows) {
            if (r.id === where.id && (r.teacherId ?? "t1") === where.teacherId) {
              Object.assign(r, data);
              count++;
            }
          }
          return { count };
        },
      ),
      findMany: vi.fn(async ({ where, select }: any) => {
        let out = tagRows.slice();
        if (where?.teacherId) out = out.filter((r) => (r.teacherId ?? "t1") === where.teacherId);
        if (where?.id?.in) out = out.filter((r) => where.id.in.includes(r.id));
        if (where?.archived === false) out = out.filter((r) => !r.archived);
        if (where?.categoryId?.in)
          out = out.filter((r) => where.categoryId.in.includes(r.categoryId));
        out.sort((a, b) => a.position - b.position);
        // resolveFocusTagsWithCategory selects a nested category.code — mirror
        // Prisma's join shape rather than the flat categoryId column.
        if (select?.category) {
          return out.map((r) => ({
            ...r,
            category: { code: categoryRows.find((c) => c.id === r.categoryId)?.code },
          }));
        }
        return out;
      }),
      groupBy: vi.fn(async ({ where }: any) => {
        let out = tagRows.slice();
        if (where?.teacherId) out = out.filter((r) => (r.teacherId ?? "t1") === where.teacherId);
        if (where?.archived === false) out = out.filter((r) => !r.archived);
        if (where?.categoryId?.in)
          out = out.filter((r) => where.categoryId.in.includes(r.categoryId));
        const byCategory = new Map<string, number>();
        for (const r of out) byCategory.set(r.categoryId, (byCategory.get(r.categoryId) ?? 0) + 1);
        return [...byCategory.entries()].map(([categoryId, count]) => ({
          categoryId,
          _count: { _all: count },
        }));
      }),
    },
    focusTagCategory: {
      createMany: vi.fn(async ({ data }: { data: Omit<FakeCategoryRow, "id">[] }) => {
        let count = 0;
        for (const d of data) {
          if (
            !categoryRows.some(
              (r) => r.code === d.code && (r.teacherId ?? "t1") === (d.teacherId ?? "t1"),
            )
          ) {
            categoryRows.push({ id: `cat-${nextCategoryId++}`, ...d });
            count++;
          }
        }
        return { count };
      }),
      create: vi.fn(async ({ data }: { data: Omit<FakeCategoryRow, "id"> }) => {
        const row = { id: `newcat-${nextCategoryId++}`, archived: false, ...data };
        categoryRows.push(row);
        return row;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; teacherId: string };
          data: Partial<FakeCategoryRow>;
        }) => {
          let count = 0;
          for (const r of categoryRows) {
            if (r.id === where.id && (r.teacherId ?? "t1") === where.teacherId) {
              Object.assign(r, data);
              count++;
            }
          }
          return { count };
        },
      ),
      findMany: vi.fn(async ({ where }: any) => {
        let out = categoryRows.slice();
        if (where?.teacherId) out = out.filter((r) => (r.teacherId ?? "t1") === where.teacherId);
        if (where?.id?.in) out = out.filter((r) => where.id.in.includes(r.id));
        if (where?.archived === false) out = out.filter((r) => !r.archived);
        out.sort((a, b) => a.position - b.position);
        return out;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          categoryRows.find((r) => r.id === where.id) ?? null,
      ),
    },
  };
}

const BUILTIN_CODES = FOCUS_TAG_BUILTIN_CATEGORIES.map((c) => c.code);

describe("ensureTeacherFocusCategories", () => {
  it("seeds the builtin categories, localized", async () => {
    const db = fakeDb();
    await ensureTeacherFocusCategories("t1", "en", db as any);
    expect(db.categoryRows).toHaveLength(BUILTIN_CODES.length);
    expect(db.categoryRows.map((c) => c.code).sort()).toEqual([...BUILTIN_CODES].sort());
    expect(db.categoryRows.find((c) => c.code === "grammar")?.label).toBe("Grammar");
    // Gap G1 (docs/features/library-materials.md) — "Format" ships as a
    // builtin category alongside the original five.
    expect(db.categoryRows.find((c) => c.code === "format")?.label).toBe("Format");
  });

  it("localizes to Spanish", async () => {
    const db = fakeDb();
    await ensureTeacherFocusCategories("t1", "es-MX", db as any);
    expect(db.categoryRows.find((c) => c.code === "grammar")?.label).toBe("Gramática");
  });

  it("is idempotent — a second call adds nothing", async () => {
    const db = fakeDb();
    await ensureTeacherFocusCategories("t1", "en", db as any);
    const after = db.categoryRows.length;
    await ensureTeacherFocusCategories("t1", "en", db as any);
    expect(db.categoryRows.length).toBe(after);
  });
});

describe("getTeacherFocusCategories", () => {
  it("self-seeds on first read when the teacher has none", async () => {
    const db = fakeDb();
    const categories = await getTeacherFocusCategories("t1", "en", db as any);
    expect(categories).toHaveLength(BUILTIN_CODES.length);
  });

  it("returns existing categories without reseeding", async () => {
    const db = fakeDb([], [{ id: "x", code: "custom:a", label: "Mine", position: 0 }]);
    const categories = await getTeacherFocusCategories("t1", "en", db as any);
    expect(categories).toHaveLength(1);
    expect(categories[0].label).toBe("Mine");
  });
});

describe("ensureTeacherFocusTags", () => {
  it("seeds the language's pack PLUS the format pack, with pack-prefixed codes, resolving each tag's categoryId", async () => {
    const db = fakeDb();
    await ensureTeacherFocusTags("t1", "es", "en", db as any);
    const { pack, seeds } = focusTagSeedFor("es");
    expect(db.tagRows.length).toBe(seeds.length + FORMAT_TAG_SEEDS.length);
    expect(
      db.tagRows.every((r) => r.code.startsWith(`${pack}:`) || r.code.startsWith("format:")),
    ).toBe(true);
    // Every tag's categoryId resolves to a real category row of the matching code.
    const categoryById = new Map(db.categoryRows.map((c) => [c.id, c]));
    const allSeeds = [
      ...seeds.map((s) => ({ ...s, code: `${pack}:${s.key}` })),
      ...FORMAT_TAG_SEEDS.map((s) => ({ category: "format" as const, code: `format:${s.key}` })),
    ];
    for (const tag of db.tagRows) {
      const seed = allSeeds.find((s) => s.code === tag.code)!;
      expect(categoryById.get(tag.categoryId)?.code).toBe(seed.category);
    }
  });

  it("is idempotent — a second call adds nothing", async () => {
    const db = fakeDb();
    await ensureTeacherFocusTags("t1", "en", "en", db as any);
    const after = db.tagRows.length;
    await ensureTeacherFocusTags("t1", "en", "en", db as any);
    expect(db.tagRows.length).toBe(after);
  });

  it("offsets a second pack's positions past the existing max (no collision)", async () => {
    const db = fakeDb();
    await ensureTeacherFocusTags("t1", "es", "en", db as any);
    const maxAfterFirst = Math.max(...db.tagRows.map((r) => r.position));
    await ensureTeacherFocusTags("t1", "fr", "en", db as any);
    const musicRows = db.tagRows.filter((r) => r.code.startsWith("music:"));
    // Every music tag sits above everything from the Spanish pack.
    expect(Math.min(...musicRows.map((r) => r.position))).toBeGreaterThan(maxAfterFirst);
    // No two tags share a position.
    const positions = db.tagRows.map((r) => r.position);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("skips seeding a tag whose builtin category the teacher already archived", async () => {
    const db = fakeDb();
    await ensureTeacherFocusCategories("t1", "en", db as any);
    const grammarCategory = db.categoryRows.find((c) => c.code === "grammar")!;
    grammarCategory.archived = true;
    await ensureTeacherFocusTags("t1", "es", "en", db as any);
    expect(db.tagRows.some((r) => r.code === "spanish:presente")).toBe(false);
  });
});

describe("getTeacherFocusTags", () => {
  it("self-seeds on first read when the teacher has none", async () => {
    const db = fakeDb();
    const tags = await getTeacherFocusTags("t1", "es", "en", db as any);
    expect(tags.length).toBeGreaterThan(0);
  });

  it("returns existing tags without reseeding", async () => {
    const db = fakeDb(
      [{ id: "x", code: "custom:a", label: "Mine", categoryId: "cat-1", position: 1 }],
      [{ id: "cat-1", code: "grammar", label: "Grammar", position: 0 }],
    );
    const tags = await getTeacherFocusTags("t1", "es", "en", db as any);
    expect(tags).toHaveLength(1);
    expect(tags[0].label).toBe("Mine");
  });
});

describe("getTeacherFocusGroups", () => {
  it("groups tags by category, in the teacher's own category order", async () => {
    const db = fakeDb(
      [
        { id: "a", code: "spanish:comida", label: "Comida", categoryId: "cat-vocab", position: 2 },
        {
          id: "b",
          code: "spanish:presente",
          label: "Presente",
          categoryId: "cat-grammar",
          position: 1,
        },
      ],
      [
        { id: "cat-grammar", code: "grammar", label: "Grammar", position: 0 },
        { id: "cat-vocab", code: "vocabulary", label: "Vocabulary", position: 1 },
      ],
    );
    const groups = await getTeacherFocusGroups("t1", "es", "en", db as any);
    expect(groups.map((g) => g.categoryLabel)).toEqual(["Grammar", "Vocabulary"]);
    expect(groups[0].tags).toEqual([{ id: "b", label: "Presente" }]);
  });

  it("omits categories with no tags", async () => {
    const db = fakeDb(
      [
        {
          id: "a",
          code: "spanish:presente",
          label: "Presente",
          categoryId: "cat-grammar",
          position: 0,
        },
      ],
      [
        { id: "cat-grammar", code: "grammar", label: "Grammar", position: 0 },
        { id: "cat-vocab", code: "vocabulary", label: "Vocabulary", position: 1 },
      ],
    );
    const groups = await getTeacherFocusGroups("t1", "es", "en", db as any);
    expect(groups.map((g) => g.categoryLabel)).toEqual(["Grammar"]);
  });

  it("self-seeds both tags and categories when the teacher has none", async () => {
    const db = fakeDb();
    const groups = await getTeacherFocusGroups("t1", "es", "en", db as any);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((g) => g.tags.length > 0)).toBe(true);
  });
});

describe("resolveFocusTagLabels", () => {
  const db = fakeDb([
    { id: "a", code: "spanish:presente", label: "Presente", categoryId: "cat-1", position: 1 },
    { id: "b", code: "spanish:comida", label: "Comida", categoryId: "cat-2", position: 15 },
  ]);

  it("resolves ids to labels in tag order", async () => {
    // Pass ids out of order; result should follow position order.
    const labels = await resolveFocusTagLabels("t1", ["b", "a"], db as any);
    expect(labels).toEqual(["Presente", "Comida"]);
  });

  it("dedups and ignores empty ids; empty input short-circuits", async () => {
    expect(await resolveFocusTagLabels("t1", [], db as any)).toEqual([]);
    expect(await resolveFocusTagLabels("t1", ["", "  "].filter(Boolean), db as any)).toEqual([]);
    const labels = await resolveFocusTagLabels("t1", ["a", "a", ""], db as any);
    expect(labels).toEqual(["Presente"]);
  });
});

describe("saveFocusTagsForTeacher", () => {
  const withCategory = (id = "cat-1") => [{ id, code: "grammar", label: "Grammar", position: 0 }];

  beforeEach(() => {
    state.pro = true;
  });

  it("blocks a Free teacher with the upgrade nudge and writes nothing", async () => {
    state.pro = false;
    const db = fakeDb([], withCategory());
    const r = await saveFocusTagsForTeacher(
      {
        teacherId: "t1",
        locale: "en",
        rows: [{ label: "New one", categoryId: "cat-1", keep: true }],
      },
      db as any,
    );
    expect(r).toEqual({ ok: false, code: "not-pro", message: "UPGRADE" });
    expect(db.tagRows).toHaveLength(0);
  });

  it("creates an id-less kept row with a pack-free, teacher-unique code", async () => {
    const db = fakeDb([], withCategory());
    const r = await saveFocusTagsForTeacher(
      {
        teacherId: "t1",
        locale: "en",
        rows: [{ label: "Pronunciación", categoryId: "cat-1", keep: true }],
      },
      db as any,
    );
    expect(r.ok).toBe(true);
    expect(db.tagRows).toHaveLength(1);
    expect(db.tagRows[0].label).toBe("Pronunciación");
    expect(db.tagRows[0].categoryId).toBe("cat-1");
    expect(db.tagRows[0].code).toMatch(/^custom:pronunciacion-[0-9a-f]{6}$/);
  });

  // Regression: production hit a 500 ("Transaction already closed") because
  // the write loop awaited each row's create/updateMany one at a time —
  // fine for a couple of rows, but a full seeded pack (30+ rows) blew past
  // Prisma's interactive-transaction timeout well before the loop finished.
  // The fix dispatches every row's write concurrently (Promise.all) instead
  // of sequentially; this test proves that fix didn't also scramble
  // `position` — it must reflect submission order, not completion order.
  it("keeps positions in submitted order even when the underlying writes resolve out of order", async () => {
    const created: { label: string; position: number }[] = [];
    // First row resolves LAST, second row FIRST, third row in the middle —
    // deliberately the opposite of submission order.
    const delaysMs = [30, 5, 15];
    let call = 0;
    const db = {
      focusTagCategory: {
        findMany: vi.fn(async () => [{ id: "cat-1" }]),
      },
      focusTag: {
        create: vi.fn(async ({ data }: { data: { label: string; position: number } }) => {
          const delay = delaysMs[call++];
          await new Promise((resolve) => setTimeout(resolve, delay));
          created.push({ label: data.label, position: data.position });
          return { id: `id-${created.length}`, ...data };
        }),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () =>
          created.map((d, i) => ({ id: `id-${i + 1}`, ...d, categoryId: "cat-1" })),
        ),
      },
    };
    const r = await saveFocusTagsForTeacher(
      {
        teacherId: "t1",
        locale: "en",
        rows: [
          { label: "First", categoryId: "cat-1", keep: true },
          { label: "Second", categoryId: "cat-1", keep: true },
          { label: "Third", categoryId: "cat-1", keep: true },
        ],
      },
      db as any,
    );
    expect(r.ok).toBe(true);
    expect(created.find((d) => d.label === "First")?.position).toBe(0);
    expect(created.find((d) => d.label === "Second")?.position).toBe(1);
    expect(created.find((d) => d.label === "Third")?.position).toBe(2);
  });

  it("discards an id-less row that was added then unchecked in the same submission", async () => {
    const db = fakeDb([], withCategory());
    const r = await saveFocusTagsForTeacher(
      {
        teacherId: "t1",
        locale: "en",
        rows: [{ label: "Nope", categoryId: "cat-1", keep: false }],
      },
      db as any,
    );
    expect(r.ok).toBe(true);
    expect(db.tagRows).toHaveLength(0);
  });

  it("archives a kept-false existing row, scoped to the owning teacher", async () => {
    const db = fakeDb(
      [
        {
          id: "a",
          code: "spanish:presente",
          label: "Presente",
          categoryId: "cat-1",
          position: 0,
          teacherId: "t1",
        },
      ],
      withCategory(),
    );
    const r = await saveFocusTagsForTeacher(
      {
        teacherId: "t1",
        locale: "en",
        rows: [{ id: "a", label: "Presente", categoryId: "cat-1", keep: false }],
      },
      db as any,
    );
    expect(r.ok).toBe(true);
    expect(db.tagRows[0].archived).toBe(true);
  });

  it("renames/reorders/recategorizes existing rows and never touches another teacher's row", async () => {
    const db = fakeDb(
      [
        {
          id: "a",
          code: "spanish:presente",
          label: "Presente",
          categoryId: "cat-1",
          position: 0,
          teacherId: "t1",
        },
        {
          id: "b",
          code: "spanish:futuro",
          label: "Futuro",
          categoryId: "cat-1",
          position: 1,
          teacherId: "t1",
        },
        {
          id: "x",
          code: "other:tag",
          label: "Other teacher's",
          categoryId: "cat-1",
          position: 0,
          teacherId: "t2",
        },
      ],
      [
        { id: "cat-1", code: "grammar", label: "Grammar", position: 0 },
        { id: "cat-2", code: "vocabulary", label: "Vocabulary", position: 1 },
      ],
    );
    const r = await saveFocusTagsForTeacher(
      {
        teacherId: "t1",
        locale: "en",
        rows: [
          { id: "b", label: "Futuro", categoryId: "cat-1", keep: true },
          { id: "a", label: "Presente (renamed)", categoryId: "cat-2", keep: true },
          { id: "x", label: "Hijack attempt", categoryId: "cat-1", keep: true },
        ],
      },
      db as any,
    );
    expect(r.ok).toBe(true);
    const a = db.tagRows.find((row) => row.id === "a")!;
    const b = db.tagRows.find((row) => row.id === "b")!;
    const x = db.tagRows.find((row) => row.id === "x")!;
    expect(b.position).toBe(0);
    expect(a.label).toBe("Presente (renamed)");
    expect(a.categoryId).toBe("cat-2");
    expect(a.position).toBe(1);
    // Cross-tenant id in the payload is a no-op — never renamed, never repositioned.
    expect(x.label).toBe("Other teacher's");
    expect(x.position).toBe(0);
  });

  it("rejects a blank label and writes nothing", async () => {
    const db = fakeDb([], withCategory());
    const r = await saveFocusTagsForTeacher(
      { teacherId: "t1", locale: "en", rows: [{ label: "  ", categoryId: "cat-1", keep: true }] },
      db as any,
    );
    expect(r.ok).toBe(false);
    expect(db.tagRows).toHaveLength(0);
  });

  it("rejects a missing or unknown categoryId and writes nothing", async () => {
    const db = fakeDb([], withCategory());
    const missing = await saveFocusTagsForTeacher(
      { teacherId: "t1", locale: "en", rows: [{ label: "Something", categoryId: "", keep: true }] },
      db as any,
    );
    expect(missing.ok).toBe(false);
    const unknown = await saveFocusTagsForTeacher(
      {
        teacherId: "t1",
        locale: "en",
        rows: [{ label: "Something", categoryId: "not-mine", keep: true }],
      },
      db as any,
    );
    expect(unknown.ok).toBe(false);
    expect(db.tagRows).toHaveLength(0);
  });

  it("rejects a categoryId belonging to another teacher", async () => {
    const db = fakeDb(
      [],
      [{ id: "cat-other", code: "grammar", label: "Grammar", position: 0, teacherId: "t2" }],
    );
    const r = await saveFocusTagsForTeacher(
      {
        teacherId: "t1",
        locale: "en",
        rows: [{ label: "Something", categoryId: "cat-other", keep: true }],
      },
      db as any,
    );
    expect(r.ok).toBe(false);
  });
});

describe("saveFocusCategoriesForTeacher", () => {
  beforeEach(() => {
    state.pro = true;
  });

  it("blocks a Free teacher with the upgrade nudge and writes nothing", async () => {
    state.pro = false;
    const db = fakeDb();
    const r = await saveFocusCategoriesForTeacher(
      { teacherId: "t1", locale: "en", rows: [{ label: "New one", keep: true }] },
      db as any,
    );
    expect(r).toEqual({ ok: false, code: "not-pro", message: "UPGRADE" });
    expect(db.categoryRows).toHaveLength(0);
  });

  it("creates an id-less kept row with a teacher-unique custom code", async () => {
    const db = fakeDb();
    const r = await saveFocusCategoriesForTeacher(
      { teacherId: "t1", locale: "en", rows: [{ label: "Pronunciation", keep: true }] },
      db as any,
    );
    expect(r.ok).toBe(true);
    expect(db.categoryRows).toHaveLength(1);
    expect(db.categoryRows[0].label).toBe("Pronunciation");
    expect(db.categoryRows[0].code).toMatch(/^custom:pronunciation-[0-9a-f]{6}$/);
  });

  it("rejects a blank label and writes nothing", async () => {
    const db = fakeDb();
    const r = await saveFocusCategoriesForTeacher(
      { teacherId: "t1", locale: "en", rows: [{ label: "   ", keep: true }] },
      db as any,
    );
    expect(r.ok).toBe(false);
    expect(db.categoryRows).toHaveLength(0);
  });

  it("archives a kept-false existing row that has no tags", async () => {
    const db = fakeDb(
      [],
      [{ id: "cat-1", code: "grammar", label: "Grammar", position: 0, teacherId: "t1" }],
    );
    const r = await saveFocusCategoriesForTeacher(
      { teacherId: "t1", locale: "en", rows: [{ id: "cat-1", label: "Grammar", keep: false }] },
      db as any,
    );
    expect(r.ok).toBe(true);
    expect(db.categoryRows[0].archived).toBe(true);
  });

  it("rejects deleting a category that still has active focus tags, naming it and the count", async () => {
    const db = fakeDb(
      [
        {
          id: "t1tag",
          code: "spanish:presente",
          label: "Presente",
          categoryId: "cat-1",
          position: 0,
          teacherId: "t1",
        },
        {
          id: "t1tag2",
          code: "spanish:futuro",
          label: "Futuro",
          categoryId: "cat-1",
          position: 1,
          teacherId: "t1",
        },
      ],
      [{ id: "cat-1", code: "grammar", label: "Grammar", position: 0, teacherId: "t1" }],
    );
    const r = await saveFocusCategoriesForTeacher(
      { teacherId: "t1", locale: "en", rows: [{ id: "cat-1", label: "Grammar", keep: false }] },
      db as any,
    );
    expect(r).toEqual({
      ok: false,
      code: "in-use",
      message: 'Can\'t delete "Grammar" (2) — still has focus tags. Move or delete them first.',
    });
    // Nothing was archived.
    expect(db.categoryRows[0].archived).toBeFalsy();
  });

  it("does not block deleting a category whose only tags are already archived", async () => {
    const db = fakeDb(
      [
        {
          id: "t1tag",
          code: "spanish:presente",
          label: "Presente",
          categoryId: "cat-1",
          position: 0,
          teacherId: "t1",
          archived: true,
        },
      ],
      [{ id: "cat-1", code: "grammar", label: "Grammar", position: 0, teacherId: "t1" }],
    );
    const r = await saveFocusCategoriesForTeacher(
      { teacherId: "t1", locale: "en", rows: [{ id: "cat-1", label: "Grammar", keep: false }] },
      db as any,
    );
    expect(r.ok).toBe(true);
    expect(db.categoryRows[0].archived).toBe(true);
  });

  it("renames/reorders existing rows and never touches another teacher's row", async () => {
    const db = fakeDb(
      [],
      [
        { id: "a", code: "grammar", label: "Grammar", position: 0, teacherId: "t1" },
        { id: "b", code: "vocabulary", label: "Vocabulary", position: 1, teacherId: "t1" },
        { id: "x", code: "grammar", label: "Other teacher's", position: 0, teacherId: "t2" },
      ],
    );
    const r = await saveFocusCategoriesForTeacher(
      {
        teacherId: "t1",
        locale: "en",
        rows: [
          { id: "b", label: "Vocabulary", keep: true },
          { id: "a", label: "Grammar (renamed)", keep: true },
          { id: "x", label: "Hijack attempt", keep: true },
        ],
      },
      db as any,
    );
    expect(r.ok).toBe(true);
    const a = db.categoryRows.find((row) => row.id === "a")!;
    const b = db.categoryRows.find((row) => row.id === "b")!;
    const x = db.categoryRows.find((row) => row.id === "x")!;
    expect(b.position).toBe(0);
    expect(a.label).toBe("Grammar (renamed)");
    expect(a.position).toBe(1);
    expect(x.label).toBe("Other teacher's");
    expect(x.position).toBe(0);
  });
});

// Gap G1 (docs/features/library-materials.md) — the "Format" axis
// (worksheet/reading/song/quiz…) is layered onto EVERY teacher's tags
// regardless of language, unlike the language-specific packs above.
describe("ensureTeacherFocusTags — format pack", () => {
  it("layers all format seeds on top of the language pack, for every language", async () => {
    const db = fakeDb();
    await ensureTeacherFocusTags("t1", "fr", "es-MX", db as any);
    const formatRows = db.tagRows.filter((r) => r.code.startsWith("format:"));
    expect(formatRows).toHaveLength(FORMAT_TAG_SEEDS.length);
    const { pack, seeds } = focusTagSeedFor("fr");
    const packRows = db.tagRows.filter((r) => r.code.startsWith(`${pack}:`));
    expect(packRows).toHaveLength(seeds.length);
  });

  it("localizes format labels independently of the language pack's fixed language", async () => {
    const dbEs = fakeDb();
    await ensureTeacherFocusTags("t1", "en", "es-MX", dbEs as any);
    const cancion = dbEs.tagRows.find((r) => r.code === "format:cancion");
    expect(cancion?.label).toBe("Canción");

    const dbEn = fakeDb();
    await ensureTeacherFocusTags("t1", "en", "en", dbEn as any);
    const song = dbEn.tagRows.find((r) => r.code === "format:cancion");
    expect(song?.label).toBe("Song");
  });

  it("still layers the format pack when the language taught is unset", async () => {
    const db = fakeDb();
    await ensureTeacherFocusTags("t1", null, "en", db as any);
    expect(db.tagRows.some((r) => r.code === "format:kahoot")).toBe(true);
  });

  it("is idempotent for the format pack too", async () => {
    const db = fakeDb();
    await ensureTeacherFocusTags("t1", "es", "en", db as any);
    const after = db.tagRows.filter((r) => r.code.startsWith("format:")).length;
    await ensureTeacherFocusTags("t1", "es", "en", db as any);
    expect(db.tagRows.filter((r) => r.code.startsWith("format:")).length).toBe(after);
  });
});

describe("resolveOwnedFocusTagIds", () => {
  const db = fakeDb([
    {
      id: "a",
      code: "spanish:presente",
      label: "Presente",
      categoryId: "cat-1",
      position: 1,
      teacherId: "t1",
    },
    {
      id: "b",
      code: "spanish:comida",
      label: "Comida",
      categoryId: "cat-2",
      position: 2,
      teacherId: "t1",
    },
    {
      id: "x",
      code: "other:tag",
      label: "Other teacher's",
      categoryId: "cat-1",
      position: 0,
      teacherId: "t2",
    },
  ]);

  it("returns only ids that belong to the requesting teacher and are active", async () => {
    const ids = await resolveOwnedFocusTagIds("t1", ["a", "b", "x", "nope"], db as any);
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("dedups and short-circuits on empty input", async () => {
    expect(await resolveOwnedFocusTagIds("t1", [], db as any)).toEqual([]);
    const ids = await resolveOwnedFocusTagIds("t1", ["a", "a"], db as any);
    expect(ids).toEqual(["a"]);
  });
});

describe("resolveFocusTagsWithCategory", () => {
  it("returns each tag's label AND its category code, tenant-scoped", async () => {
    const db = fakeDb(
      [
        {
          id: "fmt1",
          code: "format:lecturas",
          label: "Lecturas",
          categoryId: "cat-format",
          position: 0,
          teacherId: "t1",
        },
        {
          id: "gr1",
          code: "spanish:presente",
          label: "Presente",
          categoryId: "cat-grammar",
          position: 1,
          teacherId: "t1",
        },
        {
          id: "x",
          code: "other:tag",
          label: "Not mine",
          categoryId: "cat-format",
          position: 0,
          teacherId: "t2",
        },
      ],
      [
        { id: "cat-format", code: "format", label: "Formato", position: 5 },
        { id: "cat-grammar", code: "grammar", label: "Gramática", position: 0 },
      ],
    );
    const tags = await resolveFocusTagsWithCategory("t1", ["fmt1", "gr1", "x"], db as any);
    expect(tags).toEqual([
      { id: "fmt1", label: "Lecturas", categoryCode: "format" },
      { id: "gr1", label: "Presente", categoryCode: "grammar" },
    ]);
  });
});
