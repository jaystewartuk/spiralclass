import { describe, expect, it } from "vitest";
import {
  FOCUS_TAG_CATEGORY_LABEL_MAX_CHARS,
  FOCUS_TAG_CATEGORY_MAX_PER_TEACHER,
  FOCUS_TAG_LABEL_MAX_CHARS,
  FOCUS_TAG_MAX_PER_TEACHER,
  filterFocusGroups,
  isDuplicateFocusLabel,
  matchesFocusQuery,
  normalizeFocusLabel,
} from "./focus-tag-editing";
import * as focusTags from "./focus-tags";

type Category = { id: string; label: string };
type Tag = { id: string; label: string };

const GROUPS: { category: Category; tags: Tag[] }[] = [
  {
    category: { id: "c1", label: "Gramática" },
    tags: [
      { id: "t1", label: "Pretérito" },
      { id: "t2", label: "Subjuntivo" },
    ],
  },
  {
    category: { id: "c2", label: "Vocabulario" },
    tags: [
      { id: "t3", label: "Comida" },
      { id: "t4", label: "Viajes" },
    ],
  },
  { category: { id: "c3", label: "Formato" }, tags: [] },
];

describe("the caps have exactly one declaration", () => {
  // lib/focus-tags.ts re-exports these rather than re-declaring them, so the
  // settings editor's `maxLength` and the server validation that rejects an
  // over-long label are provably the same number. A copy-paste back into
  // focus-tags.ts would pass typecheck and silently reintroduce the drift.
  it("re-exports the same values through the server module", () => {
    expect(focusTags.FOCUS_TAG_LABEL_MAX_CHARS).toBe(FOCUS_TAG_LABEL_MAX_CHARS);
    expect(focusTags.FOCUS_TAG_CATEGORY_LABEL_MAX_CHARS).toBe(FOCUS_TAG_CATEGORY_LABEL_MAX_CHARS);
    expect(focusTags.FOCUS_TAG_MAX_PER_TEACHER).toBe(FOCUS_TAG_MAX_PER_TEACHER);
    expect(focusTags.FOCUS_TAG_CATEGORY_MAX_PER_TEACHER).toBe(FOCUS_TAG_CATEGORY_MAX_PER_TEACHER);
  });
});

describe("normalizeFocusLabel", () => {
  it("ignores case, surrounding space and combining accents", () => {
    expect(normalizeFocusLabel("  Pretérito ")).toBe("preterito");
    expect(normalizeFocusLabel("PRETERITO")).toBe(normalizeFocusLabel("pretérito"));
  });

  it("leaves an empty label empty, so a blank name never matches anything", () => {
    expect(normalizeFocusLabel("   ")).toBe("");
  });
});

describe("matchesFocusQuery", () => {
  it("matches on a substring, unaccented either way round", () => {
    expect(matchesFocusQuery("Pretérito", "preter")).toBe(true);
    expect(matchesFocusQuery("Preterito", "pretérito")).toBe(true);
    expect(matchesFocusQuery("Subjuntivo", "preter")).toBe(false);
  });
});

describe("filterFocusGroups", () => {
  it("returns every group untouched, by reference, for an empty query", () => {
    const result = filterFocusGroups(GROUPS, "  ");
    expect(result.groups).toBe(GROUPS);
    expect(result.matches).toBe(4);
  });

  it("keeps only the matching tags, and drops a group that has none", () => {
    const { groups, matches } = filterFocusGroups(GROUPS, "viaj");
    expect(groups.map((g) => g.category.id)).toEqual(["c2"]);
    expect(groups[0].tags.map((t) => t.id)).toEqual(["t4"]);
    expect(matches).toBe(1);
  });

  it("keeps ALL of a category's tags when the CATEGORY is what matched", () => {
    // Searching a category by name is a request for that category, so hiding
    // the tags under it would answer the question with an empty card.
    const { groups, matches } = filterFocusGroups(GROUPS, "gram");
    expect(groups).toHaveLength(1);
    expect(groups[0]).toBe(GROUPS[0]);
    expect(groups[0].tags).toHaveLength(2);
    // Two tags plus the category name itself.
    expect(matches).toBe(3);
  });

  it("counts a matching but empty category as a result rather than zero", () => {
    const { groups, matches } = filterFocusGroups(GROUPS, "formato");
    expect(groups.map((g) => g.category.id)).toEqual(["c3"]);
    expect(matches).toBe(1);
  });

  it("returns nothing at all when neither a tag nor a category matches", () => {
    const { groups, matches } = filterFocusGroups(GROUPS, "zzz");
    expect(groups).toEqual([]);
    expect(matches).toBe(0);
  });

  it("can match across several categories at once", () => {
    const { groups, matches } = filterFocusGroups(
      [
        { category: { id: "c1", label: "A" }, tags: [{ id: "t1", label: "Comida rápida" }] },
        { category: { id: "c2", label: "B" }, tags: [{ id: "t2", label: "Comida casera" }] },
      ],
      "comida",
    );
    expect(groups).toHaveLength(2);
    expect(matches).toBe(2);
  });
});

describe("isDuplicateFocusLabel", () => {
  const siblings = [
    { id: "t1", label: "Ser vs estar" },
    { id: "t2", label: "Pretérito" },
  ];

  it("flags a name already used by a sibling, ignoring case and accents", () => {
    expect(isDuplicateFocusLabel("preterito", siblings)).toBe(true);
    expect(isDuplicateFocusLabel("  SER VS ESTAR  ", siblings)).toBe(true);
  });

  it("does not flag the row being edited against itself", () => {
    expect(isDuplicateFocusLabel("Pretérito", siblings, "t2")).toBe(false);
    expect(isDuplicateFocusLabel("Pretérito", siblings, "t1")).toBe(true);
  });

  it("never flags a blank name — that is the required-name hint's job", () => {
    expect(isDuplicateFocusLabel("   ", siblings)).toBe(false);
  });

  it("is false against an empty sibling set", () => {
    expect(isDuplicateFocusLabel("Anything", [])).toBe(false);
  });
});
