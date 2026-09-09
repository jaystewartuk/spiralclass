import { describe, expect, it } from "vitest";

import {
  extractHomeworkExcerptText,
  hasHomeworkCallout,
  parseInline,
  parseMaterialDoc,
} from "./parse";
import type { MaterialBlock } from "./types";

function blocks(body: string): MaterialBlock[] {
  return parseMaterialDoc(body).blocks;
}

describe("parseInline", () => {
  it("parses plain text as a single node", () => {
    expect(parseInline("hello world")).toEqual([{ type: "text", value: "hello world" }]);
  });

  it("parses bold, italic and code", () => {
    expect(parseInline("a **b** c *d* e `f`")).toEqual([
      { type: "text", value: "a " },
      { type: "strong", children: [{ type: "text", value: "b" }] },
      { type: "text", value: " c " },
      { type: "em", children: [{ type: "text", value: "d" }] },
      { type: "text", value: " e " },
      { type: "code", value: "f" },
    ]);
  });

  it("nests a link inside strong", () => {
    expect(parseInline("**see [docs](https://x.test)**")).toEqual([
      {
        type: "strong",
        children: [
          { type: "text", value: "see " },
          { type: "link", href: "https://x.test", children: [{ type: "text", value: "docs" }] },
        ],
      },
    ]);
  });

  it("parses links and keeps the href verbatim", () => {
    expect(parseInline("see [docs](https://x.test/a)")).toEqual([
      { type: "text", value: "see " },
      { type: "link", href: "https://x.test/a", children: [{ type: "text", value: "docs" }] },
    ]);
  });
});

describe("parseMaterialDoc — core blocks (backwards compatible)", () => {
  it("parses headings, clamping depth to 3", () => {
    const b = blocks("# One\n## Two\n#### Deep");
    expect(b.map((x) => x.type === "heading" && x.level)).toEqual([1, 2, 3]);
  });

  it("parses paragraphs joining soft-wrapped lines", () => {
    const b = blocks("first line\nsame paragraph\n\nsecond");
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ type: "paragraph" });
    expect(b[0].type === "paragraph" && b[0].inlines[0]).toEqual({
      type: "text",
      value: "first line same paragraph",
    });
  });

  it("parses unordered and ordered lists", () => {
    const ul = blocks("- a\n- b")[0];
    expect(ul).toMatchObject({ type: "list", ordered: false });
    const ol = blocks("1. a\n2. b")[0];
    expect(ol).toMatchObject({ type: "list", ordered: true });
    expect(ol.type === "list" && ol.items).toHaveLength(2);
  });

  it("parses a fenced code block with a language", () => {
    const b = blocks("```js\nconst x = 1;\n```")[0];
    expect(b).toEqual({ type: "code", text: "const x = 1;", lang: "js" });
  });

  it("parses a thematic break as a divider", () => {
    expect(blocks("---")[0]).toEqual({ type: "divider" });
  });

  it("parses a GFM table with alignment", () => {
    const b = blocks("| A | B |\n|:--|--:|\n| 1 | 2 |")[0];
    expect(b.type).toBe("table");
    if (b.type === "table") {
      expect(b.align).toEqual(["left", "right"]);
      expect(b.header).toHaveLength(2);
      expect(b.rows).toHaveLength(1);
    }
  });

  it("treats a plain blockquote as a quote block", () => {
    const b = blocks("> just a quote")[0];
    expect(b.type).toBe("quote");
    if (b.type === "quote") expect(b.blocks[0]).toMatchObject({ type: "paragraph" });
  });
});

describe("parseMaterialDoc — semantic callouts (the new capability)", () => {
  it("recognises a [!tip] callout and its body", () => {
    const b = blocks("> [!tip]\n> Practice daily.")[0];
    expect(b.type).toBe("callout");
    if (b.type === "callout") {
      expect(b.variant).toBe("tip");
      expect(b.title).toBeNull();
      expect(b.blocks[0]).toMatchObject({ type: "paragraph" });
    }
  });

  it("captures an inline callout title after the marker", () => {
    const b = blocks("> [!vocabulary] Key words\n> - casa — house")[0];
    expect(b.type).toBe("callout");
    if (b.type === "callout") {
      expect(b.variant).toBe("vocabulary");
      expect(b.title).toEqual([{ type: "text", value: "Key words" }]);
      expect(b.blocks[0]).toMatchObject({ type: "list" });
    }
  });

  it("is case-insensitive on the variant name", () => {
    const b = blocks("> [!WARNING]\n> Careful.")[0];
    expect(b.type === "callout" && b.variant).toBe("warning");
  });

  it("falls back to a plain quote for an unknown variant", () => {
    const b = blocks("> [!bogus]\n> hi")[0];
    expect(b.type).toBe("quote");
  });

  it("supports every declared variant", () => {
    for (const v of [
      "note",
      "info",
      "tip",
      "important",
      "warning",
      "remember",
      "example",
      "exercise",
      "question",
      "answer",
      "vocabulary",
      "grammar",
      "summary",
      "homework",
    ]) {
      const b = blocks(`> [!${v}]\n> body`)[0];
      expect(b.type === "callout" && b.variant).toBe(v);
    }
  });
});

describe("parseMaterialDoc — lists", () => {
  it("parses GFM task-list items", () => {
    const b = blocks("- [ ] todo\n- [x] done")[0];
    expect(b.type).toBe("list");
    if (b.type === "list") {
      expect(b.items[0].checked).toBe(false);
      expect(b.items[1].checked).toBe(true);
      expect(b.items[1].inlines[0]).toEqual({ type: "text", value: "done" });
    }
  });

  it("folds an indented sub-list into the parent item", () => {
    const b = blocks("- parent\n  - child a\n  - child b")[0];
    expect(b.type).toBe("list");
    if (b.type === "list") {
      expect(b.items).toHaveLength(1);
      const child = b.items[0].children[0];
      expect(child).toMatchObject({ type: "list" });
      if (child.type === "list") expect(child.items).toHaveLength(2);
    }
  });
});

describe("parseMaterialDoc — resilience", () => {
  it("handles an empty body", () => {
    expect(blocks("")).toEqual([]);
  });

  it("tolerates a truncated (streaming) tail without throwing", () => {
    expect(() => blocks("# Title\n\n> [!tip]\n> half writ")).not.toThrow();
    const b = blocks("```js\nconst x =");
    expect(b[0]).toMatchObject({ type: "code" });
  });

  it("normalises CRLF line endings", () => {
    expect(blocks("# A\r\n\r\nB")).toHaveLength(2);
  });
});

describe("hasHomeworkCallout", () => {
  it("is false for a doc with no callouts", () => {
    expect(hasHomeworkCallout(parseMaterialDoc("# Title\n\nJust a paragraph."))).toBe(false);
  });

  it("is false for an unrelated callout variant", () => {
    expect(hasHomeworkCallout(parseMaterialDoc("> [!tip]\n> Study a little every day."))).toBe(
      false,
    );
  });

  it("is true for a top-level [!homework] callout", () => {
    expect(hasHomeworkCallout(parseMaterialDoc("> [!homework]\n> Write 5 sentences."))).toBe(true);
  });

  it("is true for a top-level [!exercise] callout", () => {
    expect(hasHomeworkCallout(parseMaterialDoc("> [!exercise]\n> Fill in the blanks."))).toBe(true);
  });

  it("finds a homework callout nested inside a list item", () => {
    const body = "- Practice tips\n  > [!homework]\n  > Read chapter 2.";
    expect(hasHomeworkCallout(parseMaterialDoc(body))).toBe(true);
  });

  it("finds a homework callout nested inside a quote", () => {
    const body = "> Outer note\n> > [!homework]\n> > Do the worksheet.";
    expect(hasHomeworkCallout(parseMaterialDoc(body))).toBe(true);
  });
});

describe("extractHomeworkExcerptText", () => {
  it("returns an empty string for a doc with no homework/exercise/answer callout", () => {
    const body = "# Title\n\nJust a paragraph.\n\n> [!tip]\n> Study a little every day.";
    expect(extractHomeworkExcerptText(parseMaterialDoc(body))).toBe("");
  });

  it("extracts a top-level [!homework] callout's text", () => {
    const body = "> [!homework]\n> Write 5 sentences using the present perfect.";
    expect(extractHomeworkExcerptText(parseMaterialDoc(body))).toBe(
      "[homework]\nWrite 5 sentences using the present perfect.",
    );
  });

  it("excludes unrelated callouts and prose outside any homework callout", () => {
    const body =
      "> [!tip]\n> Study daily.\n\n> [!exercise]\n> Fill in the blanks.\n\nSome closing prose.";
    const excerpt = extractHomeworkExcerptText(parseMaterialDoc(body));
    expect(excerpt).toContain("Fill in the blanks.");
    expect(excerpt).not.toContain("Study daily.");
    expect(excerpt).not.toContain("Some closing prose.");
  });

  it("concatenates multiple homework-family callouts in document order", () => {
    const body = "> [!exercise]\n> Question 1.\n\n> [!answer]\n> Answer 1.";
    const excerpt = extractHomeworkExcerptText(parseMaterialDoc(body));
    expect(excerpt.indexOf("Question 1.")).toBeLessThan(excerpt.indexOf("Answer 1."));
  });

  it("finds a homework callout nested inside a list item", () => {
    const body = "- Practice tips\n  > [!homework]\n  > Read chapter 2.";
    expect(extractHomeworkExcerptText(parseMaterialDoc(body))).toContain("Read chapter 2.");
  });
});
