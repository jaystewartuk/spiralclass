import { describe, expect, it } from "vitest";
import {
  groupMaterialsByCategory,
  type MaterialCategoryMeta,
  type MaterialTag,
} from "./materials-grouping";

// Teacher category order: grammar(1) < vocab(2) < skill(3) < format(4) < theme(5).
const CATS: MaterialCategoryMeta[] = [
  { id: "grammar", label: "Gramática", position: 1 },
  { id: "vocab", label: "Vocabulario", position: 2 },
  { id: "skill", label: "Destrezas", position: 3 },
  { id: "format", label: "Formato", position: 4 },
  { id: "theme", label: "Temática", position: 5 },
];

const tag = (id: string, categoryId: string): MaterialTag => ({ id, label: id, categoryId });

type Item = { id: string; tags: MaterialTag[] };
const item = (id: string, ...tags: MaterialTag[]): Item => ({ id, tags });

const ids = (groups: { items: Item[] }[]) => groups.map((g) => g.items.map((i) => i.id));

describe("groupMaterialsByCategory", () => {
  it("places a material in exactly one bucket — its highest-priority category", () => {
    // Tagged grammar + format → primary is grammar (position 1 < 4).
    const groups = groupMaterialsByCategory(
      [item("m1", tag("subj", "grammar"), tag("worksheet", "format"))],
      CATS,
      "Otros",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ categoryId: "grammar", categoryLabel: "Gramática" });
    expect(ids(groups)).toEqual([["m1"]]);
  });

  it("emits category groups in the teacher's position order, skipping empty ones", () => {
    const groups = groupMaterialsByCategory(
      [
        item("theme1", tag("cultura", "theme")),
        item("gram1", tag("ser", "grammar")),
        item("skill1", tag("listening", "skill")),
      ],
      CATS,
      "Otros",
    );
    // grammar(1), skill(3), theme(5) — vocab/format have no items and are omitted.
    expect(groups.map((g) => g.categoryId)).toEqual(["grammar", "skill", "theme"]);
  });

  it("preserves the caller's within-bucket order (caller pre-sorts by level/position)", () => {
    const groups = groupMaterialsByCategory(
      [
        item("a", tag("t1", "grammar")),
        item("b", tag("t2", "grammar")),
        item("c", tag("t3", "grammar")),
      ],
      CATS,
      "Otros",
    );
    expect(ids(groups)).toEqual([["a", "b", "c"]]);
  });

  it("puts tagless materials in a trailing 'uncategorized' bucket", () => {
    const groups = groupMaterialsByCategory(
      [item("tagged", tag("ser", "grammar")), item("bare")],
      CATS,
      "Otros",
    );
    expect(groups.map((g) => g.categoryId)).toEqual(["grammar", null]);
    const last = groups[groups.length - 1];
    expect(last).toMatchObject({ categoryId: null, categoryLabel: "Otros" });
    expect(last.items.map((i) => i.id)).toEqual(["bare"]);
  });

  it("ignores tags whose category is unknown (e.g. archived), falling back to uncategorized", () => {
    const groups = groupMaterialsByCategory(
      [item("m", tag("orphan", "deleted-category"))],
      CATS,
      "Otros",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].categoryId).toBeNull();
  });

  it("uses a known-category tag even when the material also has an unknown-category tag", () => {
    const groups = groupMaterialsByCategory(
      [item("m", tag("orphan", "deleted"), tag("ser", "grammar"))],
      CATS,
      "Otros",
    );
    expect(groups[0].categoryId).toBe("grammar");
  });

  it("returns [] for no items", () => {
    expect(groupMaterialsByCategory([], CATS, "Otros")).toEqual([]);
  });

  it("is deterministic when two categories share a position (tie-break by id)", () => {
    const tied: MaterialCategoryMeta[] = [
      { id: "bbb", label: "B", position: 1 },
      { id: "aaa", label: "A", position: 1 },
    ];
    // Material tagged in both tied categories → primary is the smaller id "aaa".
    const groups = groupMaterialsByCategory(
      [item("m", tag("t1", "bbb"), tag("t2", "aaa"))],
      tied,
      "Otros",
    );
    expect(groups[0].categoryId).toBe("aaa");
  });
});
