import { describe, expect, it } from "vitest";

import { parseInline, parseMaterialDoc } from "./parse";
import { serializeBlocks, serializeInline, serializeMaterialDoc } from "./serialize";
import { CALLOUT_VARIANTS } from "./types";

/** The contract: serializing a parsed tree and re-parsing it must land on the
 * SAME tree. Byte equality with the original source is explicitly not promised
 * — serializing normalizes heading/list/emphasis style. */
function expectRoundTrip(body: string) {
  const doc = parseMaterialDoc(body);
  const serialized = serializeMaterialDoc(doc);
  expect(parseMaterialDoc(serialized)).toEqual(doc);
  // Idempotent from the second pass on: serialize(parse(serialize(...))) is
  // already canonical, so a save loop can never drift.
  expect(serializeMaterialDoc(parseMaterialDoc(serialized))).toBe(serialized);
}

describe("serializeInline", () => {
  it("emits plain text verbatim", () => {
    expect(serializeInline([{ type: "text", value: "hello world" }])).toBe("hello world");
  });

  it("normalises strong and em onto the asterisk forms", () => {
    expect(serializeInline(parseInline("__a__ and _b_"))).toBe("**a** and *b*");
  });

  it("emits code, links and nesting", () => {
    expect(serializeInline(parseInline("`x` **see [docs](https://x.test/a)**"))).toBe(
      "`x` **see [docs](https://x.test/a)**",
    );
  });

  it("picks a delimiter that cannot pair with the wrapped content", () => {
    // `_a*b_` must not become `*a*b*`, which re-parses as em(a) + text.
    expect(serializeInline(parseInline("_a*b_"))).toBe("_a*b_");
    // `__a*__` must not become `**a***`, which re-parses as strong(a) + text.
    expect(serializeInline(parseInline("__a*__"))).toBe("__a*__");
  });
});

describe("serializeMaterialDoc — block coverage", () => {
  it("emits a heading at its parsed level", () => {
    expect(serializeMaterialDoc(parseMaterialDoc("### Deep"))).toBe("### Deep");
    // The parser clamps to 3, so the serializer emits 3.
    expect(serializeMaterialDoc(parseMaterialDoc("##### Deeper"))).toBe("### Deeper");
  });

  it("joins a soft-wrapped paragraph onto one line", () => {
    expect(serializeMaterialDoc(parseMaterialDoc("first line\nsame paragraph"))).toBe(
      "first line same paragraph",
    );
  });

  it("normalises list markers and renumbers ordered items by position", () => {
    expect(serializeMaterialDoc(parseMaterialDoc("* a\n+ b"))).toBe("- a\n- b");
    expect(serializeMaterialDoc(parseMaterialDoc("7) a\n9) b"))).toBe("1. a\n2. b");
  });

  it("emits task-list checkboxes", () => {
    expect(serializeMaterialDoc(parseMaterialDoc("- [ ] todo\n- [X] done"))).toBe(
      "- [ ] todo\n- [x] done",
    );
  });

  it("indents nested item content by exactly two spaces", () => {
    expect(serializeMaterialDoc(parseMaterialDoc("- parent\n    - child"))).toBe(
      "- parent\n  - child",
    );
  });

  it("emits a fenced code block with its language", () => {
    expect(serializeMaterialDoc(parseMaterialDoc("~~~js\nconst x = 1;\n~~~"))).toBe(
      "```js\nconst x = 1;\n```",
    );
  });

  it("switches the fence marker when the code body contains a fence line", () => {
    const doc = { blocks: [{ type: "code" as const, text: "```\nnested\n```", lang: null }] };
    expect(serializeMaterialDoc(doc)).toBe("~~~\n```\nnested\n```\n~~~");
    expect(parseMaterialDoc(serializeMaterialDoc(doc))).toEqual(doc);
  });

  it("emits a divider", () => {
    expect(serializeMaterialDoc(parseMaterialDoc("***"))).toBe("---");
  });

  it("emits a table with its alignment row", () => {
    expect(serializeMaterialDoc(parseMaterialDoc("|A|B|C|\n|:-|:-:|-:|\n|1|2|3|"))).toBe(
      "| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |",
    );
  });

  it("emits a plain blockquote", () => {
    expect(serializeMaterialDoc(parseMaterialDoc("> just a quote"))).toBe("> just a quote");
  });

  it("emits a callout with and without a title", () => {
    expect(serializeMaterialDoc(parseMaterialDoc("> [!TIP]\n> Practice daily."))).toBe(
      "> [!tip]\n> Practice daily.",
    );
    expect(serializeMaterialDoc(parseMaterialDoc("> [!vocabulary] Key words\n> - casa"))).toBe(
      "> [!vocabulary] Key words\n> - casa",
    );
  });

  it("separates blocks with a single blank line", () => {
    expect(serializeMaterialDoc(parseMaterialDoc("# T\n\nBody\n\n---"))).toBe("# T\n\nBody\n\n---");
  });

  it("keeps two adjacent same-family lists apart", () => {
    // A single blank line is folded back into the first list by the parser, so
    // the serializer has to emit two.
    const doc = parseMaterialDoc("- a\n\n\n- b");
    expect(doc.blocks).toHaveLength(2);
    expect(serializeMaterialDoc(doc)).toBe("- a\n\n\n- b");
    expect(parseMaterialDoc(serializeMaterialDoc(doc))).toEqual(doc);
  });

  it("serializes an empty document to an empty string", () => {
    expect(serializeMaterialDoc({ blocks: [] })).toBe("");
  });
});

describe("serializeBlocks", () => {
  it("serializes a block run — the unit a per-section AI refine sends", () => {
    const doc = parseMaterialDoc("# T\n\nIntro\n\n## Part\n\nBody");
    expect(serializeBlocks(doc.blocks.slice(2))).toBe("## Part\n\nBody");
  });
});

// --- the round-trip property ------------------------------------------------

const FIXTURES: Record<string, string> = {
  empty: "",
  headings: "# One\n\n## Two\n\n### Three\n\n#### Clamped to three",
  paragraphs: "A paragraph that\nsoft-wraps.\n\nAnother one.",
  inlineMarks:
    "Mix **strong**, *em*, `code`, [a link](https://x.test/a?b=1#c) and **nested *em* inside**.",
  inlineUnderscores: "__strong__ plus _em_ plus snake_case_word in prose.",
  inlineUnmatched: "A lone * asterisk and a stray _ underscore and 3 ** 4 stay text.",
  unorderedList: "- alpha\n- beta\n- gamma",
  orderedList: "1. first\n2. second\n3. third",
  taskList: "- [ ] not done\n- [x] done\n- [ ] **bold** task",
  nestedList: "- parent\n  - child a\n  - child b\n- sibling",
  listWithBlocks:
    "1. Step one\n\n   Extra prose for step one.\n\n   ```js\n   const x = 1;\n   ```\n2. Step two",
  listWithCallout: "- Practice tips\n  > [!homework]\n  > Read chapter 2.",
  adjacentLists: "- a\n- b\n\n\n- c\n- d",
  mixedLists: "- bullet\n\n1. number",
  code: "```ts\nexport const x: number = 1;\n\nconsole.log(x);\n```",
  codeNoLang: "```\nplain text\n```",
  codeTruncated: "```js\nconst x =",
  divider: "Above\n\n---\n\nBelow",
  tableAligned: "| Word | Meaning | Note |\n| :--- | :---: | ---: |\n| casa | house | n. |",
  tableDefaultAlign: "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |",
  tableInlineCells: "| Term | Example |\n| --- | --- |\n| **casa** | *la casa* `n.` |",
  tableNoRows: "| A | B |\n| --- | --- |",
  tableEmptyCell: "| A | B |\n| --- | --- |\n| 1 |  |",
  quote: "> A plain quote\n>\n> with two paragraphs.",
  quoteNested: "> Outer note\n> > [!homework]\n> > Do the worksheet.",
  calloutTitled: "> [!vocabulary] Key words\n> - casa — house\n> - perro — dog",
  calloutUntitled: "> [!tip]\n> Practice daily.",
  calloutBare: "> [!note]",
  calloutRichBody:
    "> [!exercise] Practice\n> Fill in the blanks.\n>\n> | # | Sentence |\n> | --- | --- |\n> | 1 | I ___ home. |\n>\n> ```txt\n> go / went\n> ```",
  calloutNested: "> [!note] Outer\n> Body.\n>\n> > [!tip] Inner\n> > Nested body.",
  calloutUnknownVariant: "> [!bogus] Not a variant\n> Falls back to a quote.",
  truncatedCallout: "# Title\n\n> [!tip]\n> half writ",
  truncatedHeading: "# ",
  crlf: "# A\r\n\r\nB\r\n\r\n- c\r\n- d",
  wholeMaterial: [
    "# Present Perfect — B1",
    "",
    "A lesson plan for **60 minutes**.",
    "",
    "> [!summary] Objectives",
    "> - Form the present perfect",
    "> - Contrast with the past simple",
    "",
    "## 1. Warm-up",
    "",
    "Ask the student about *last weekend*.",
    "",
    "| Prompt | Expected |",
    "| :--- | ---: |",
    "| Have you ever…? | Yes, I have. |",
    "",
    "## 2. Practice",
    "",
    "1. Read the dialogue.",
    "2. Swap roles.",
    "",
    "> [!exercise] Gap fill",
    "> - [ ] I ___ (see) that film.",
    "> - [x] She ___ (be) to Spain.",
    "",
    "---",
    "",
    "> [!homework] For next class",
    "> Write five sentences using `never` and `ever`.",
  ].join("\n"),
};

describe("round trip — parse(serialize(parse(x))) === parse(x)", () => {
  for (const [name, body] of Object.entries(FIXTURES)) {
    it(`holds for the ${name} fixture`, () => {
      expectRoundTrip(body);
    });
  }

  it("holds for every callout variant, titled and untitled", () => {
    for (const variant of CALLOUT_VARIANTS) {
      expectRoundTrip(`> [!${variant}]\n> Body text.`);
      expectRoundTrip(`> [!${variant}] A **titled** box\n> Body text.`);
      expectRoundTrip(`> [!${variant}] Box\n> - one\n> - two\n>\n> Closing prose.`);
    }
  });

  it("holds for every callout variant nested inside another callout", () => {
    for (const variant of CALLOUT_VARIANTS) {
      expectRoundTrip(`> [!note] Outer\n> > [!${variant}] Inner\n> > Nested body.`);
    }
  });
});

// A deterministic generator (no Math.random, so a failure is reproducible)
// assembling documents out of every block shape, to catch adjacency bugs the
// hand-written fixtures miss.
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const SNIPPETS: string[] = [
  "# Heading one",
  "## 1. Numbered heading",
  "### Deep heading with **bold**",
  "A plain paragraph.",
  "A paragraph with **strong**, *em*, `code` and [a link](https://x.test/a).",
  "A paragraph with __underscores__ and _emphasis_ and a stray * star.",
  "- alpha\n- beta",
  "- [ ] todo\n- [x] done",
  "- parent\n  - child\n  - other child",
  "1. one\n2. two",
  "1. step\n\n   nested prose\n2. step",
  "```js\nconst x = 1;\n```",
  "```\nno language\n```",
  "---",
  "| A | B |\n| :--- | ---: |\n| 1 | 2 |",
  "| Only | Header |\n| --- | --- |",
  "> A plain quote.",
  "> [!tip] Titled tip\n> Body.",
  "> [!vocabulary]\n> - casa — house",
  "> [!question] Q\n> What is it?\n>\n> > [!answer] A\n> > This.",
  "> [!warning]\n> | A | B |\n> | --- | --- |\n> | 1 | 2 |",
  "- item\n  > [!note]\n  > nested callout",
];

describe("round trip — generated documents", () => {
  it("holds for 300 generated documents", () => {
    const rand = lcg(20260730);
    for (let n = 0; n < 300; n++) {
      const count = 1 + Math.floor(rand() * 6);
      const parts: string[] = [];
      for (let k = 0; k < count; k++) {
        parts.push(SNIPPETS[Math.floor(rand() * SNIPPETS.length)]);
      }
      const body = parts.join("\n\n");
      try {
        expectRoundTrip(body);
      } catch (error) {
        throw new Error(`round trip failed for generated body:\n${body}\n\n${String(error)}`);
      }
    }
  });

  it("holds for every truncation of a full material", () => {
    const body = FIXTURES.wholeMaterial;
    for (let end = 0; end <= body.length; end += 7) {
      const truncated = body.slice(0, end);
      try {
        expectRoundTrip(truncated);
      } catch (error) {
        throw new Error(
          `round trip failed for truncation at ${end}:\n${truncated}\n\n${String(error)}`,
        );
      }
    }
  });
});

describe("the minimal escape — teacher-typed text that collides with block syntax", () => {
  // The per-block editors (Phase 4) let a teacher type ARBITRARY text into
  // positions the parser previously only ever saw serializer output in. These
  // trees are unreachable from parsing alone, so each test builds the tree the
  // ops layer would build and asserts the serialize→reparse round trip lands
  // back on it — the exact corruption path of the phase-4 review findings.
  const roundTripsTree = (blocks: import("./types").MaterialBlock[]) => {
    const serialized = serializeBlocks(blocks);
    expect(parseMaterialDoc(serialized).blocks).toEqual(blocks);
    return serialized;
  };

  it("escapes a pipe typed into a table cell instead of splitting the row", () => {
    const table: import("./types").MaterialBlock = {
      type: "table",
      header: [parseInline("word"), parseInline("meaning")],
      align: [null, null],
      rows: [[parseInline("either | or"), parseInline("o esto | o lo otro")]],
    };
    const serialized = roundTripsTree([table]);
    expect(serialized).toContain("either \\| or");
  });

  it("keeps a pipe inside an inline code span in a cell", () => {
    const table: import("./types").MaterialBlock = {
      type: "table",
      header: [parseInline("syntax")],
      align: [null],
      rows: [[parseInline("`a || b`")]],
    };
    roundTripsTree([table]);
  });

  it("round-trips backslashes in cells, including literal `\\|` sequences", () => {
    const table: import("./types").MaterialBlock = {
      type: "table",
      header: [parseInline("cell")],
      align: [null],
      rows: [[[{ type: "text", value: "a\\|b and a\\b" }]]],
    };
    roundTripsTree([table]);
  });

  it("reads a GFM-escaped pipe in stored content as a literal pipe", () => {
    // AI output already escapes pipes the standard GFM way; the parser now
    // honors it instead of splitting the cell.
    const doc = parseMaterialDoc("| a |\n| --- |\n| x \\| y |");
    const table = doc.blocks[0];
    expect(table.type).toBe("table");
    if (table.type === "table") {
      expect(table.rows[0]).toHaveLength(1);
      expect(table.rows[0][0]).toEqual([{ type: "text", value: "x | y" }]);
    }
  });

  it("protects plain item text that LOOKS like a task marker", () => {
    // "[x] means correct" as literal text must not become a checked checkbox
    // with the prefix eaten.
    const list: import("./types").MaterialBlock = {
      type: "list",
      ordered: false,
      items: [{ inlines: parseInline("[x] means correct"), checked: null, children: [] }],
    };
    const serialized = roundTripsTree([list]);
    expect(serialized).toContain("\\[x] means correct");
  });

  it("still emits real task items unescaped", () => {
    const list: import("./types").MaterialBlock = {
      type: "list",
      ordered: false,
      items: [{ inlines: parseInline("done"), checked: true, children: [] }],
    };
    expect(roundTripsTree([list])).toBe("- [x] done");
  });

  it("protects divider-shaped item text from splitting the list", () => {
    const list: import("./types").MaterialBlock = {
      type: "list",
      ordered: false,
      items: [
        { inlines: parseInline("fill in: ---"), checked: null, children: [] },
        { inlines: parseInline("---"), checked: null, children: [] },
      ],
    };
    roundTripsTree([list]);
  });

  it("protects item text with a literal leading backslash", () => {
    const list: import("./types").MaterialBlock = {
      type: "list",
      ordered: false,
      items: [{ inlines: [{ type: "text", value: "\\[x] literal" }], checked: null, children: [] }],
    };
    roundTripsTree([list]);
  });

  it("keeps a heading-lookalike paragraph out of a preceding list", () => {
    // The reviewed defect: parse("- a\n\n#\nnote") yields [list, paragraph
    // "# note"]; the old leading-space reshape re-read as list continuation
    // and the paragraph vanished into the item. The escape candidate is
    // adjacency-safe.
    expectRoundTrip("- a\n\n#\nnote");
    const doc = parseMaterialDoc("- a\n\n#\nnote");
    const serialized = serializeMaterialDoc(doc);
    expect(parseMaterialDoc(serialized).blocks).toHaveLength(2);
  });

  it("round-trips paragraphs whose text opens other blocks", () => {
    const cases = ["# note", "- not a list", "1. not ordered", "> not a quote", "--- alone"];
    for (const text of cases) {
      const para: import("./types").MaterialBlock = {
        type: "paragraph",
        inlines: [{ type: "text", value: text }],
      };
      roundTripsTree([para]);
    }
  });

  it("round-trips a paragraph with a literal leading backslash", () => {
    const para: import("./types").MaterialBlock = {
      type: "paragraph",
      inlines: [{ type: "text", value: "\\- literal backslash dash" }],
    };
    roundTripsTree([para]);
  });

  it("leaves LaTeX-ish backslashes in prose alone", () => {
    // The unescape is scoped to escapable characters — `\frac` at a line start
    // must come through verbatim, old content included.
    expectRoundTrip("\\frac{a}{b} is a fraction.");
    const doc = parseMaterialDoc("\\frac{a}{b} is a fraction.");
    expect(doc.blocks[0]).toEqual({
      type: "paragraph",
      inlines: [{ type: "text", value: "\\frac{a}{b} is a fraction." }],
    });
  });
});
