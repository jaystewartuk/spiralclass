import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getStudentLibraryView } from "@/lib/library/student-view";
import { CEFR_LEVELS } from "@/lib/levels";

// CEFR levels with ids = codes, so library rows reference levelId by code.
const LEVELS = CEFR_LEVELS.map((l) => ({ id: l.code, ...l }));

// Teacher categories: grammar(1) < format(2).
const CATEGORIES = [
  { id: "grammar", label: "Gramática", position: 1 },
  { id: "format", label: "Formato", position: 2 },
];

const NOW = new Date("2026-05-01T12:00:00.000Z");
const past = new Date("2026-04-01T00:00:00.000Z"); // before NOW
const future = new Date("2026-06-01T00:00:00.000Z"); // after NOW

type Tag = { id: string; label: string; categoryId: string; archived?: boolean };
type Material = {
  id: string;
  levelId: string | null;
  label: string | null;
  unit: string | null;
  storagePath: string | null;
  linkUrl: string | null;
  body: string | null;
  visibility: "at_or_below" | "exact" | "all";
  archived?: boolean;
  createdAt?: Date;
  tags?: Tag[];
};

const mat = (id: string, over: Partial<Material> = {}): Material => ({
  id,
  levelId: "a1",
  label: id,
  unit: null,
  storagePath: `t1/${id}.pdf`,
  linkUrl: null,
  body: null,
  visibility: "at_or_below",
  tags: [],
  ...over,
});

// Prisma row shape the view selects (focusTags join).
const asRow = (m: Material) => ({
  ...m,
  focusTags: (m.tags ?? []).map((t) => ({
    focusTag: { id: t.id, label: t.label, categoryId: t.categoryId, archived: t.archived ?? false },
  })),
});

type Booking = {
  scheduledStart: Date;
  materials?: (Material & { sendTiming: string | null })[];
  libraryMaterials?: { sendTiming: string | null; material: Material }[];
};

function fakeDb(opts: {
  levelId: string | null;
  browse?: Material[];
  assigned?: { material: Material; completedAt: Date | null }[];
  bookings?: Booking[];
}): PrismaClient {
  const matchesWhere = (m: Material, where: any): boolean => {
    if (m.archived) return false;
    if (where.id?.in) return (where.id.in as string[]).includes(m.id);
    const or = where.OR as { visibility: string; levelId?: { in: string[] } }[];
    return or.some((c) => {
      if (c.visibility !== m.visibility) return false;
      if (m.visibility === "all") return true;
      if (m.visibility === "exact") return m.levelId === (c.levelId as unknown as string);
      return (m.levelId && c.levelId?.in?.includes(m.levelId)) ?? false;
    });
  };
  return {
    teacherStudent: { findFirst: vi.fn(async () => ({ teacherId: "t1", levelId: opts.levelId })) },
    level: { findMany: vi.fn(async () => LEVELS) },
    focusTagCategory: { findMany: vi.fn(async () => CATEGORIES) },
    libraryMaterial: {
      findMany: vi.fn(async ({ where }: any) =>
        (opts.browse ?? []).filter((m) => matchesWhere(m, where)).map(asRow),
      ),
    },
    studentLibraryItem: {
      findMany: vi.fn(async () =>
        (opts.assigned ?? []).map((a) => ({
          completedAt: a.completedAt,
          material: asRow(a.material),
        })),
      ),
    },
    booking: {
      findMany: vi.fn(async () =>
        (opts.bookings ?? []).map((b) => ({
          scheduledStart: b.scheduledStart,
          materials: (b.materials ?? []).map((m) => ({ ...asRow(m), sendTiming: m.sendTiming })),
          libraryMaterials: (b.libraryMaterials ?? []).map((a) => ({
            sendTiming: a.sendTiming,
            material: asRow(a.material),
          })),
        })),
      ),
    },
  } as unknown as PrismaClient;
}

const mintUrl = async (m: { storagePath: string | null; linkUrl: string | null }) =>
  m.storagePath ? `signed://${m.storagePath}` : m.linkUrl;

const deps = (db: PrismaClient) => ({ db, mintUrl, now: NOW });

// Flatten to (categoryId, item ids) for compact assertions.
const shape = (v: Awaited<ReturnType<typeof getStudentLibraryView>>) =>
  v.categories.map((g) => [g.categoryId, g.items.map((i) => i.id)] as const);

describe("getStudentLibraryView", () => {
  it("groups browse items into one primary category each, in category order", () => {
    return getStudentLibraryView(
      "s1",
      deps(
        fakeDb({
          levelId: "b1",
          browse: [
            mat("m-fmt", { tags: [{ id: "t", label: "Worksheet", categoryId: "format" }] }),
            mat("m-gram", {
              // grammar(1) outranks format(2) → primary is grammar.
              tags: [
                { id: "g", label: "Ser", categoryId: "grammar" },
                { id: "w", label: "Worksheet", categoryId: "format" },
              ],
            }),
          ],
        }),
      ),
    ).then((view) => {
      expect(view.hasLevel).toBe(true);
      expect(view.levelLabel).toBe("B1");
      expect(shape(view)).toEqual([
        ["grammar", ["m-gram"]],
        ["format", ["m-fmt"]],
      ]);
      // Tags travel with the item for chip display.
      expect(view.categories[0].items[0].tags.map((t) => t.label)).toEqual(["Ser", "Worksheet"]);
      expect(view.categories[0].items[0].source).toBe("browse");
    });
  });

  it("orders browse items within a category newest-first (retired reorder)", async () => {
    const view = await getStudentLibraryView(
      "s1",
      deps(
        fakeDb({
          levelId: "b1",
          browse: [
            mat("older", {
              createdAt: past,
              tags: [{ id: "g", label: "G", categoryId: "grammar" }],
            }),
            mat("newer", {
              createdAt: future,
              tags: [{ id: "g", label: "G", categoryId: "grammar" }],
            }),
          ],
        }),
      ),
    );
    // Newest created first, regardless of insertion/label order.
    expect(shape(view)).toEqual([["grammar", ["newer", "older"]]]);
  });

  it("a student with no level sees no browse — but still sees assigned + class items", async () => {
    const view = await getStudentLibraryView(
      "s1",
      deps(
        fakeDb({
          levelId: null,
          browse: [
            mat("all-x", {
              visibility: "all",
              tags: [{ id: "g", label: "G", categoryId: "grammar" }],
            }),
          ],
          assigned: [
            {
              material: mat("asg", { tags: [{ id: "g", label: "G", categoryId: "grammar" }] }),
              completedAt: NOW,
            },
          ],
          bookings: [
            {
              scheduledStart: past,
              libraryMaterials: [
                {
                  sendTiming: null,
                  material: mat("cls", { tags: [{ id: "g", label: "G", categoryId: "grammar" }] }),
                },
              ],
            },
          ],
        }),
      ),
    );
    // "all-x" browse item is gone (no level); assigned + class remain.
    const ids = view.categories.flatMap((g) => g.items.map((i) => i.id));
    expect(ids.sort()).toEqual(["asg", "cls"]);
    expect(view.hasLevel).toBe(false);
    expect(view.levelLabel).toBeNull();
  });

  it("marks source + completed, and shows assigned items regardless of level", async () => {
    const view = await getStudentLibraryView(
      "s1",
      deps(
        fakeDb({
          levelId: "a2",
          browse: [],
          assigned: [
            {
              material: mat("above", {
                levelId: "c2",
                tags: [{ id: "g", label: "G", categoryId: "grammar" }],
              }),
              completedAt: NOW,
            },
          ],
        }),
      ),
    );
    const item = view.categories[0].items[0];
    expect(item.id).toBe("above");
    expect(item.source).toBe("assigned");
    expect(item.completed).toBe(true);
  });

  it("aggregates class-attached materials with a send-time gate and the class date", async () => {
    const view = await getStudentLibraryView(
      "s1",
      deps(
        fakeDb({
          levelId: "a1",
          bookings: [
            {
              scheduledStart: past,
              materials: [
                // always-visible booking-scoped upload on a past class → shown.
                {
                  ...mat("up", {
                    levelId: null,
                    tags: [{ id: "g", label: "G", categoryId: "grammar" }],
                  }),
                  sendTiming: null,
                },
              ],
            },
            {
              // Scheduled 1h before a FUTURE class → send time hasn't elapsed → hidden.
              scheduledStart: future,
              libraryMaterials: [{ sendTiming: "t_1h", material: mat("later") }],
            },
          ],
        }),
      ),
    );
    const ids = view.categories.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual(["up"]);
    const up = view.categories[0].items[0];
    expect(up.source).toBe("class");
    expect(up.classStartsAt).toBe(past.toISOString());
  });

  it("dedupes a material seen via multiple sources, keeping the most explicit", async () => {
    // "shared" is both browsable AND attached to a class → keep the class copy
    // (class outranks browse) with its class date.
    const view = await getStudentLibraryView(
      "s1",
      deps(
        fakeDb({
          levelId: "b1",
          browse: [mat("shared", { tags: [{ id: "g", label: "G", categoryId: "grammar" }] })],
          bookings: [
            {
              scheduledStart: past,
              libraryMaterials: [
                {
                  sendTiming: null,
                  material: mat("shared", {
                    tags: [{ id: "g", label: "G", categoryId: "grammar" }],
                  }),
                },
              ],
            },
          ],
        }),
      ),
    );
    const ids = view.categories.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual(["shared"]); // once, not twice
    expect(view.categories[0].items[0].source).toBe("class");
    expect(view.categories[0].items[0].classStartsAt).toBe(past.toISOString());
  });

  it("puts tagless materials in a trailing uncategorized bucket (categoryId null)", async () => {
    const view = await getStudentLibraryView(
      "s1",
      deps(
        fakeDb({
          levelId: "b1",
          browse: [
            mat("tagged", { tags: [{ id: "g", label: "G", categoryId: "grammar" }] }),
            mat("bare", { tags: [] }),
          ],
        }),
      ),
    );
    expect(shape(view)).toEqual([
      ["grammar", ["tagged"]],
      [null, ["bare"]],
    ]);
  });

  it("ignores archived tags when bucketing", async () => {
    const view = await getStudentLibraryView(
      "s1",
      deps(
        fakeDb({
          levelId: "b1",
          browse: [
            mat("m", {
              tags: [
                { id: "dead", label: "Old", categoryId: "grammar", archived: true },
                { id: "live", label: "Worksheet", categoryId: "format" },
              ],
            }),
          ],
        }),
      ),
    );
    // grammar tag is archived → primary category is format.
    expect(shape(view)).toEqual([["format", ["m"]]]);
    expect(view.categories[0].items[0].tags.map((t) => t.id)).toEqual(["live"]);
  });

  it("returns empty for a student with no teacher link", async () => {
    const db = {
      teacherStudent: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const view = await getStudentLibraryView("orphan", { db, mintUrl, now: NOW });
    expect(view).toEqual({ hasLevel: false, levelLabel: null, categories: [] });
  });

  // This view is student-facing end to end, so it ships the student COPY of
  // every body: the `> [!answer]` callouts are the teacher's answer key and
  // are cut before the entry is built. The renderer's "Show answer" toggle
  // collapses them, which is presentation — an unstripped body here is one
  // /api/mobile/student/library request away from being the answer key.
  describe("answer-key filtering", () => {
    const ANSWERED = [
      "> [!exercise]",
      "> Complete the gap: She (go) to school.",
      "",
      "> [!answer]",
      "> goes",
    ].join("\n");
    const withBody = (id: string, body: string) =>
      mat(id, { storagePath: null, linkUrl: null, body });

    it("cuts the answer key out of a browse / assigned / class-attached body alike", async () => {
      const view = await getStudentLibraryView(
        "s1",
        deps(
          fakeDb({
            levelId: "b1",
            browse: [withBody("browsed", ANSWERED)],
            assigned: [{ material: withBody("assigned", ANSWERED), completedAt: null }],
            bookings: [
              {
                scheduledStart: past,
                libraryMaterials: [{ sendTiming: null, material: withBody("attached", ANSWERED) }],
              },
            ],
          }),
        ),
      );
      const items = view.categories.flatMap((c) => c.items);
      expect(items.map((i) => i.id).sort()).toEqual(["assigned", "attached", "browsed"]);
      for (const item of items) {
        expect(item.body).toContain("Complete the gap");
        expect(item.body).not.toContain("[!answer]");
        expect(item.body).not.toContain("goes");
        // Still a content material — the strip must not flip the kind.
        expect(item.attachmentKind).toBe("content");
      }
      expect(JSON.stringify(view)).not.toContain("[!answer]");
    });

    it("leaves a body with no answer key byte-identical", async () => {
      const body = "# Lesson\n\n> [!tip]\n> Read it aloud.";
      const view = await getStudentLibraryView(
        "s1",
        deps(fakeDb({ levelId: "b1", browse: [withBody("clean", body)] })),
      );
      expect(view.categories.flatMap((c) => c.items)[0].body).toBe(body);
    });
  });
});
