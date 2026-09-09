import { describe, expect, it } from "vitest";

import { parseMaterialDoc } from "./parse";
import {
  deleteSection,
  duplicateSection,
  insertSection,
  joinSections,
  moveSection,
  renumberHeadings,
  splitSections,
  type MaterialSection,
} from "./sections";
import { serializeMaterialDoc } from "./serialize";
import type { MaterialDoc } from "./types";

/** Sections are a view over Markdown, so the tests drive them the way the
 * editor will: parse a body, operate, serialize back. */
function edit(body: string, op: (doc: MaterialDoc) => MaterialDoc): string {
  return serializeMaterialDoc(op(parseMaterialDoc(body)));
}

function headings(body: string, options?: { level?: 1 | 2 | 3 }): string[] {
  return splitSections(parseMaterialDoc(body), options).map((section) =>
    section.heading ? serializeMaterialDoc({ blocks: [section.heading] }) : "(preamble)",
  );
}

/** The editor granularity for the `NUMBERED` fixture: everything hangs under a
 * single `# Lesson`, so the useful cards are the `##` parts. */
const AT_PART_LEVEL = { level: 2 } as const;

const NUMBERED = [
  "# Lesson",
  "",
  "Intro prose.",
  "",
  "## 1. Warm-up",
  "",
  "Chat about the weekend.",
  "",
  "## 2. Practice",
  "",
  "- drill one",
  "- drill two",
  "",
  "## 3. Wrap-up",
  "",
  "Recap.",
].join("\n");

const NO_PREAMBLE = "# A\n\nBody A\n\n# B\n\nBody B\n\n# C\n\nBody C";

describe("splitSections", () => {
  it("returns nothing for an empty document", () => {
    expect(splitSections(parseMaterialDoc(""))).toEqual([]);
  });

  it("puts blocks before the first heading in a synthetic preamble section", () => {
    const sections = splitSections(parseMaterialDoc("Intro prose.\n\n---\n\n# Title\n\nBody"));
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBeNull();
    expect(sections[0].blocks.map((b) => b.type)).toEqual(["paragraph", "divider"]);
    expect(sections[1].heading).toMatchObject({ type: "heading", level: 1 });
    expect(sections[1].blocks.map((b) => b.type)).toEqual(["paragraph"]);
  });

  it("has no preamble section when the document opens with a heading", () => {
    expect(headings(NO_PREAMBLE)).toEqual(["# A", "# B", "# C"]);
  });

  it("keeps a deeper subheading inside its parent section", () => {
    const sections = splitSections(parseMaterialDoc("# A\n\nx\n\n## A.1\n\ny\n\n# B\n\nz"));
    expect(sections).toHaveLength(2);
    expect(sections[0].blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "paragraph"]);
  });

  it("closes a section on a heading of the same or a higher level", () => {
    // Starting at H2, the H1 that follows closes it and owns the H2 after that.
    expect(headings("## Lead\n\nx\n\n# Top\n\ny\n\n## Under\n\nz")).toEqual(["## Lead", "# Top"]);
  });

  it("makes a document that hangs under one title a single section", () => {
    expect(headings(NUMBERED)).toEqual(["# Lesson"]);
  });

  it("cuts at every heading that senior or more when given a level", () => {
    expect(headings(NUMBERED, AT_PART_LEVEL)).toEqual([
      "# Lesson",
      "## 1. Warm-up",
      "## 2. Practice",
      "## 3. Wrap-up",
    ]);
  });

  it("keeps a level-3 subheading inside its part at level 2", () => {
    const body = "# T\n\n## Part\n\nx\n\n### Sub\n\ny\n\n## Other\n\nz";
    expect(headings(body, AT_PART_LEVEL)).toEqual(["# T", "## Part", "## Other"]);
    expect(headings(body, { level: 3 })).toEqual(["# T", "## Part", "### Sub", "## Other"]);
  });

  it("still keeps the preamble section when a level is given", () => {
    const sections = splitSections(parseMaterialDoc("Intro\n\n# T\n\n## Part"), AT_PART_LEVEL);
    expect(sections[0].heading).toBeNull();
    expect(sections.map((s) => s.heading?.level ?? null)).toEqual([null, 1, 2]);
  });
});

describe("joinSections", () => {
  const BODIES = [
    "",
    "Just prose.",
    NO_PREAMBLE,
    NUMBERED,
    "Preamble\n\n### Deep only\n\nx",
    "## Lead\n\nx\n\n# Top\n\ny\n\n## Under\n\nz",
    "> [!tip]\n> No headings at all.",
  ];

  for (const [i, body] of BODIES.entries()) {
    it(`is the exact inverse of splitSections (fixture ${i})`, () => {
      const doc = parseMaterialDoc(body);
      expect(joinSections(splitSections(doc))).toEqual(doc);
      for (const level of [1, 2, 3] as const) {
        expect(joinSections(splitSections(doc, { level }))).toEqual(doc);
      }
    });
  }
});

describe("moveSection", () => {
  it("reorders two sections", () => {
    expect(edit(NO_PREAMBLE, (d) => moveSection(d, 2, 0))).toBe(
      "# C\n\nBody C\n\n# A\n\nBody A\n\n# B\n\nBody B",
    );
  });

  it("carries a section's subheadings with it", () => {
    const body = "# A\n\n## A.1\n\nx\n\n# B\n\ny";
    expect(edit(body, (d) => moveSection(d, 1, 0))).toBe("# B\n\ny\n\n# A\n\n## A.1\n\nx");
  });

  it("can move the preamble", () => {
    const body = "Intro\n\n# A\n\nBody A";
    expect(edit(body, (d) => moveSection(d, 0, 1))).toBe("# A\n\nBody A\n\nIntro");
  });

  it("clamps an out-of-range destination and ignores an out-of-range source", () => {
    const doc = parseMaterialDoc(NO_PREAMBLE);
    expect(serializeMaterialDoc(moveSection(doc, 0, 99))).toBe(
      "# B\n\nBody B\n\n# C\n\nBody C\n\n# A\n\nBody A",
    );
    expect(moveSection(doc, 9, 0)).toBe(doc);
    expect(moveSection(doc, -1, 0)).toBe(doc);
    expect(moveSection(doc, 1, 1)).toBe(doc);
  });
});

describe("deleteSection", () => {
  it("removes a heading and everything it owns", () => {
    expect(edit(NO_PREAMBLE, (d) => deleteSection(d, 1))).toBe("# A\n\nBody A\n\n# C\n\nBody C");
  });

  it("removes a subheading's body along with its parent", () => {
    expect(edit("# A\n\n## A.1\n\nx\n\n# B\n\ny", (d) => deleteSection(d, 0))).toBe("# B\n\ny");
  });

  it("removes the preamble without touching the rest", () => {
    expect(edit("Intro\n\n# A\n\nBody A", (d) => deleteSection(d, 0))).toBe("# A\n\nBody A");
  });

  it("ignores an out-of-range index", () => {
    const doc = parseMaterialDoc(NO_PREAMBLE);
    expect(deleteSection(doc, 3)).toBe(doc);
    expect(deleteSection(doc, -1)).toBe(doc);
  });

  it("empties a single-section document", () => {
    expect(edit("# Only\n\nBody", (d) => deleteSection(d, 0))).toBe("");
  });
});

describe("duplicateSection", () => {
  it("inserts a copy directly after the original", () => {
    expect(edit("# A\n\nBody A\n\n# B\n\nBody B", (d) => duplicateSection(d, 0))).toBe(
      "# A\n\nBody A\n\n# A\n\nBody A\n\n# B\n\nBody B",
    );
  });

  it("deep-copies, so editing the copy cannot mutate the original", () => {
    const doc = duplicateSection(parseMaterialDoc("# A\n\nBody A"), 0);
    const [first, second] = splitSections(doc);
    expect(first.heading).not.toBe(second.heading);
    expect(first.blocks[0]).not.toBe(second.blocks[0]);
  });

  it("ignores an out-of-range index", () => {
    const doc = parseMaterialDoc(NO_PREAMBLE);
    expect(duplicateSection(doc, 5)).toBe(doc);
  });
});

describe("insertSection", () => {
  const section: MaterialSection = {
    heading: { type: "heading", level: 1, inlines: [{ type: "text", value: "New" }] },
    blocks: [{ type: "paragraph", inlines: [{ type: "text", value: "Fresh." }] }],
  };

  it("inserts before the given index", () => {
    expect(edit(NO_PREAMBLE, (d) => insertSection(d, 1, section))).toBe(
      "# A\n\nBody A\n\n# New\n\nFresh.\n\n# B\n\nBody B\n\n# C\n\nBody C",
    );
  });

  it("appends when the index is at or past the end", () => {
    expect(edit("# A\n\nBody A", (d) => insertSection(d, 99, section))).toBe(
      "# A\n\nBody A\n\n# New\n\nFresh.",
    );
  });

  it("prepends at index 0, ahead of a preamble", () => {
    expect(edit("Intro\n\n# A\n\nBody A", (d) => insertSection(d, 0, section))).toBe(
      "# New\n\nFresh.\n\nIntro\n\n# A\n\nBody A",
    );
  });

  it("deep-copies the template, so it can be reused", () => {
    const doc = insertSection(parseMaterialDoc("# A"), 1, section);
    expect(splitSections(doc)[1].heading).not.toBe(section.heading);
  });
});

describe("split / join round trip under editing", () => {
  it("survives a delete-then-reinsert of the same section", () => {
    const doc = parseMaterialDoc(NO_PREAMBLE);
    const sections = splitSections(doc);
    const restored = insertSection(deleteSection(doc, 1), 1, sections[1]);
    expect(restored).toEqual(doc);
  });

  it("survives a move there and back", () => {
    const doc = parseMaterialDoc(NO_PREAMBLE);
    expect(moveSection(moveSection(doc, 0, 2), 2, 0)).toEqual(doc);
  });
});

// --- renumbering ------------------------------------------------------------

describe("renumberHeadings", () => {
  it("leaves a document with no numbered headings alone", () => {
    const doc = parseMaterialDoc(NO_PREAMBLE);
    expect(renumberHeadings(doc)).toBe(doc);
  });

  it("leaves a lone numbered heading alone — one is prose, not an index", () => {
    const doc = parseMaterialDoc("## 2024. A retrospective\n\nx\n\n## Plans\n\ny");
    expect(renumberHeadings(doc)).toBe(doc);
  });

  it("rewrites a numbered set into 1..n", () => {
    expect(edit("## 3. c\n\n## 7. a\n\n## 2. b", (d) => renumberHeadings(d))).toBe(
      "## 1. c\n\n## 2. a\n\n## 3. b",
    );
  });

  it("keeps each heading's own separator style", () => {
    expect(edit("## 4) a\n\n## 9. b", (d) => renumberHeadings(d))).toBe("## 1) a\n\n## 2. b");
  });

  it("numbers each level independently", () => {
    expect(edit("# 5. Top\n\n## 2. Sub\n\n## 8. Sub\n\n# 9. Top", (d) => renumberHeadings(d))).toBe(
      "# 1. Top\n\n## 1. Sub\n\n## 2. Sub\n\n# 2. Top",
    );
  });

  it("restarts a level under each parent heading", () => {
    const body = "# A\n\n## 4. x\n\n## 5. y\n\n# B\n\n## 7. p\n\n## 8. q";
    expect(edit(body, (d) => renumberHeadings(d))).toBe(
      "# A\n\n## 1. x\n\n## 2. y\n\n# B\n\n## 1. p\n\n## 2. q",
    );
  });

  it("skips unnumbered siblings without consuming an ordinal", () => {
    expect(edit("## 4. a\n\n## Notes\n\n## 9. b", (d) => renumberHeadings(d))).toBe(
      "## 1. a\n\n## Notes\n\n## 2. b",
    );
  });

  it("ignores a number that is not a heading prefix", () => {
    const doc = parseMaterialDoc("## Chapter 3\n\n## Chapter 4");
    expect(renumberHeadings(doc)).toBe(doc);
  });

  it("ignores a prefix with no space after the separator", () => {
    const doc = parseMaterialDoc("## 3.c\n\n## 7.a");
    expect(renumberHeadings(doc)).toBe(doc);
  });

  it("keeps the rest of a heading's inline content, including markup", () => {
    expect(edit("## 4. a **bold** part\n\n## 9. b", (d) => renumberHeadings(d))).toBe(
      "## 1. a **bold** part\n\n## 2. b",
    );
  });
});

describe("renumbering through the structural operations", () => {
  const part = (level: 2, text: string): MaterialSection => ({
    heading: { type: "heading", level, inlines: [{ type: "text", value: text }] },
    blocks: [],
  });

  it("renumbers after a delete", () => {
    expect(edit(NUMBERED, (d) => deleteSection(d, 2, AT_PART_LEVEL))).toBe(
      [
        "# Lesson",
        "",
        "Intro prose.",
        "",
        "## 1. Warm-up",
        "",
        "Chat about the weekend.",
        "",
        "## 2. Wrap-up",
        "",
        "Recap.",
      ].join("\n"),
    );
  });

  it("renumbers after a move", () => {
    const moved = edit(NUMBERED, (d) => moveSection(d, 3, 1, AT_PART_LEVEL));
    expect(moved).toContain("## 1. Wrap-up");
    expect(moved).toContain("## 2. Warm-up");
    expect(moved).toContain("## 3. Practice");
    expect(moved.indexOf("Wrap-up")).toBeLessThan(moved.indexOf("Warm-up"));
  });

  it("renumbers after a duplicate", () => {
    const doubled = edit(NUMBERED, (d) => duplicateSection(d, 1, AT_PART_LEVEL));
    expect(doubled).toContain("## 1. Warm-up");
    expect(doubled).toContain("## 2. Warm-up");
    expect(doubled).toContain("## 3. Practice");
    expect(doubled).toContain("## 4. Wrap-up");
  });

  it("renumbers after an insert", () => {
    const withExtra = edit(NUMBERED, (d) =>
      insertSection(d, 2, part(2, "5. Review"), AT_PART_LEVEL),
    );
    expect(withExtra).toContain("## 1. Warm-up");
    expect(withExtra).toContain("## 2. Review");
    expect(withExtra).toContain("## 3. Practice");
    expect(withExtra).toContain("## 4. Wrap-up");
  });

  it("leaves an inserted unnumbered heading unnumbered, and skips it in the count", () => {
    const unnumbered = edit(NUMBERED, (d) => insertSection(d, 2, part(2, "Review"), AT_PART_LEVEL));
    expect(unnumbered).toContain("## 1. Warm-up");
    expect(unnumbered).toContain("## Review");
    expect(unnumbered).toContain("## 2. Practice");
    expect(unnumbered).toContain("## 3. Wrap-up");
  });

  it("leaves ordered lists alone — their numbering is derived at render", () => {
    const body = "## 4. Steps\n\n1. one\n2. two\n\n## 9. More\n\n7) seven\n9) nine";
    expect(edit(body, (d) => renumberHeadings(d))).toBe(
      "## 1. Steps\n\n1. one\n2. two\n\n## 2. More\n\n1. seven\n2. nine",
    );
  });
});

describe("purity", () => {
  it("never mutates the input document", () => {
    const doc = parseMaterialDoc(NUMBERED);
    const before = JSON.stringify(doc);
    moveSection(doc, 1, 3, AT_PART_LEVEL);
    deleteSection(doc, 1, AT_PART_LEVEL);
    duplicateSection(doc, 1, AT_PART_LEVEL);
    insertSection(doc, 1, { heading: null, blocks: [{ type: "divider" }] }, AT_PART_LEVEL);
    renumberHeadings(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("keeps every operation's output serialisable and re-parsable", () => {
    const doc = parseMaterialDoc(NUMBERED);
    for (const next of [
      moveSection(doc, 1, 3, AT_PART_LEVEL),
      deleteSection(doc, 2, AT_PART_LEVEL),
      duplicateSection(doc, 1, AT_PART_LEVEL),
      insertSection(doc, 1, { heading: null, blocks: [{ type: "divider" }] }, AT_PART_LEVEL),
    ]) {
      expect(parseMaterialDoc(serializeMaterialDoc(next))).toEqual(next);
    }
  });
});
