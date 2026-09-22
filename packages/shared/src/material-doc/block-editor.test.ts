import { describe, expect, it } from "vitest";

import { parseBlockText, parseMaterialDoc } from "./parse";
import { serializeBlock } from "./serialize";
import {
  editBlockText,
  insertBlockAt,
  insertListItem,
  insertTableColumn,
  insertTableRow,
  moveListItem,
  newCalloutBlock,
  newDividerBlock,
  newListBlock,
  newParagraphBlock,
  newTableBlock,
  removeBlockAt,
  removeListItem,
  removeTableColumn,
  removeTableRow,
  replaceBlockAt,
  toggleListItemChecked,
  updateBlockAt,
  updateCalloutTitle,
  updateCalloutVariant,
  updateListItemText,
  updateTableCell,
  type CalloutBlock,
  type ListBlock,
  type TableBlock,
} from "./block-editor";
import { CALLOUT_VARIANTS } from "./types";
import type { MaterialBlock } from "./types";

// The per-block editing primitives (MATERIAL_EDITING phase 4). The shared
// section-op tests (sections.test.ts) cover the level above this one (a
// document's sections); this file covers the level below (a section's own
// body blocks) — flat MaterialBlock[] in, one out.

function block(body: string): MaterialBlock {
  const blocks = parseMaterialDoc(body).blocks;
  expect(blocks).toHaveLength(1);
  return blocks[0];
}

/** The inline run a lone-paragraph fixture parses to — used to build the
 * expected value for a re-parsed text field without a type assertion at every
 * call site. */
function inlinesOf(text: string) {
  const only = block(text);
  if (only.type !== "paragraph") throw new Error(`expected a paragraph, got ${only.type}`);
  return only.inlines;
}

// --- serializeBlock / parseBlockText round trip -----------------------------

describe("serializeBlock / parseBlockText — single-block round trip", () => {
  const FIXTURES: Record<string, string> = {
    heading: "## A heading",
    paragraph: "A paragraph with **strong** and *em* and `code`.",
    unorderedList: "- alpha\n- beta",
    orderedList: "1. first\n2. second",
    taskList: "- [ ] todo\n- [x] done",
    nestedList: "- parent\n  - child",
    divider: "---",
    code: "```js\nconst x = 1;\n```",
    codeNoLang: "```\nplain\n```",
    table: "| A | B |\n| :--- | ---: |\n| 1 | 2 |",
    quote: "> A plain quote.",
    calloutUntitled: "> [!tip]\n> Body.",
    calloutTitled: "> [!vocabulary] Key words\n> - casa",
  };

  for (const [name, body] of Object.entries(FIXTURES)) {
    it(`round-trips the ${name} fixture`, () => {
      const original = block(body);
      const reparsed = parseBlockText(serializeBlock(original));
      expect(reparsed).toEqual([original]);
    });
  }

  it("round-trips every callout variant", () => {
    for (const variant of CALLOUT_VARIANTS) {
      const original = block(`> [!${variant}] Title\n> Body.`);
      expect(parseBlockText(serializeBlock(original))).toEqual([original]);
    }
  });

  it("lets an emptied field delete the block (0 blocks back)", () => {
    expect(parseBlockText("")).toEqual([]);
  });

  it("lets edited text promote to a different block type", () => {
    // A paragraph's own text field, retyped as list syntax, becomes a list —
    // the same 'whatever it parses to' rule the section-level AI splice uses.
    expect(parseBlockText("- now a list item")).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          { inlines: [{ type: "text", value: "now a list item" }], checked: null, children: [] },
        ],
      },
    ]);
  });

  it("keeps a fenced code block's content verbatim even when it looks like markdown", () => {
    const original = block("```\n# not a heading\n* not a list\n```");
    expect(original).toEqual({ type: "code", text: "# not a heading\n* not a list", lang: null });
    expect(parseBlockText(serializeBlock(original))).toEqual([original]);
  });
});

// --- generic block-list ops --------------------------------------------------

describe("replaceBlockAt / updateBlockAt / removeBlockAt / insertBlockAt", () => {
  const blocks = [block("# A"), block("Body one."), block("Body two.")];

  it("replaceBlockAt splices 0..n blocks in at the index", () => {
    expect(replaceBlockAt(blocks, 1, [])).toEqual([blocks[0], blocks[2]]);
    expect(replaceBlockAt(blocks, 1, [block("New body.")])).toEqual([
      blocks[0],
      block("New body."),
      blocks[2],
    ]);
    expect(replaceBlockAt(blocks, 1, [block("One."), block("Two.")])).toHaveLength(4);
  });

  it("replaceBlockAt is a no-op out of range", () => {
    expect(replaceBlockAt(blocks, -1, [])).toBe(blocks);
    expect(replaceBlockAt(blocks, 99, [])).toBe(blocks);
  });

  it("updateBlockAt replaces exactly one block", () => {
    const next = updateBlockAt(blocks, 0, block("# B"));
    expect(next[0]).toEqual(block("# B"));
    expect(next).toHaveLength(3);
  });

  it("removeBlockAt deletes one block", () => {
    expect(removeBlockAt(blocks, 0)).toEqual([blocks[1], blocks[2]]);
  });

  it("insertBlockAt inserts at a clamped position", () => {
    const inserted = block("Inserted.");
    expect(insertBlockAt(blocks, 0, inserted)).toEqual([inserted, ...blocks]);
    expect(insertBlockAt(blocks, 99, inserted)).toEqual([...blocks, inserted]);
  });
});

describe("editBlockText", () => {
  const blocks = [block("First."), block("Second.")];

  it("reparses the edited text and splices the result back in", () => {
    expect(editBlockText(blocks, 1, "Edited second.")).toEqual([
      blocks[0],
      block("Edited second."),
    ]);
  });

  it("deletes the block when the field is emptied", () => {
    expect(editBlockText(blocks, 1, "")).toEqual([blocks[0]]);
  });

  it("expands into several blocks when the edited text has more than one", () => {
    const next = editBlockText(blocks, 1, "One.\n\nTwo.");
    expect(next).toEqual([blocks[0], block("One."), block("Two.")]);
  });
});

// --- callout field edits ------------------------------------------------------

describe("updateCalloutVariant / updateCalloutTitle", () => {
  const callout = block("> [!tip] Original title\n> Body.") as CalloutBlock;

  it("changes only the variant", () => {
    const next = updateCalloutVariant(callout, "warning");
    expect(next.variant).toBe("warning");
    expect(next.title).toEqual(callout.title);
    expect(next.blocks).toEqual(callout.blocks);
  });

  it("re-parses a new title", () => {
    const next = updateCalloutTitle(callout, "A **new** title");
    expect(next.title).toEqual(inlinesOf("A **new** title"));
    expect(serializeBlock(next)).toContain("A **new** title");
  });

  it("clears the title on empty text — the renderer falls back to the variant's default label", () => {
    expect(updateCalloutTitle(callout, "   ").title).toBeNull();
  });
});

// --- list-item ops -------------------------------------------------------------

describe("list-item ops", () => {
  function list(body: string): ListBlock {
    return block(body) as ListBlock;
  }

  it("updateListItemText re-parses only that item's inlines", () => {
    const l = list("- alpha\n- beta");
    const next = updateListItemText(l, 0, "**Alpha**");
    expect(next.items[0].inlines).toEqual(inlinesOf("**Alpha**"));
    expect(next.items[1]).toEqual(l.items[1]);
  });

  it("toggleListItemChecked flips only a task item", () => {
    const l = list("- [ ] todo\n- plain");
    expect(toggleListItemChecked(l, 0).items[0].checked).toBe(true);
    // A plain (non-task) item has nothing to toggle.
    expect(toggleListItemChecked(l, 1)).toBe(l);
  });

  it("insertListItem matches the list's own checklist-ness", () => {
    const plain = list("- a\n- b");
    expect(insertListItem(plain, 1, "c").items[1].checked).toBeNull();
    const checklist = list("- [ ] a\n- [x] b");
    expect(insertListItem(checklist, 1, "c").items[1].checked).toBe(false);
  });

  it("removeListItem drops one item", () => {
    const l = list("- a\n- b\n- c");
    expect(removeListItem(l, 1).items.map((i) => i.inlines)).toEqual([
      l.items[0].inlines,
      l.items[2].inlines,
    ]);
  });

  it("moveListItem reorders, and is a no-op when nothing would change", () => {
    const l = list("- a\n- b\n- c");
    const moved = moveListItem(l, 0, 2);
    expect(moved.items.map((i) => i.inlines)).toEqual([
      l.items[1].inlines,
      l.items[2].inlines,
      l.items[0].inlines,
    ]);
    expect(moveListItem(l, 1, 1)).toBe(l);
    expect(moveListItem(l, 9, 0)).toBe(l);
  });
});

// --- table ops -----------------------------------------------------------------

describe("table ops", () => {
  function table(body: string): TableBlock {
    return block(body) as TableBlock;
  }

  it("updateTableCell edits the header row at -1", () => {
    const t = table("| A | B |\n| --- | --- |\n| 1 | 2 |");
    const next = updateTableCell(t, -1, 0, "Renamed");
    expect(next.header[0]).toEqual(inlinesOf("Renamed"));
    expect(next.header[1]).toEqual(t.header[1]);
  });

  it("updateTableCell edits a data row", () => {
    const t = table("| A | B |\n| --- | --- |\n| 1 | 2 |");
    const next = updateTableCell(t, 0, 1, "changed");
    expect(next.rows[0][1]).toEqual(inlinesOf("changed"));
    expect(next.rows[0][0]).toEqual(t.rows[0][0]);
  });

  it("insertTableRow / removeTableRow", () => {
    const t = table("| A | B |\n| --- | --- |\n| 1 | 2 |");
    const withRow = insertTableRow(t, 0);
    expect(withRow.rows).toHaveLength(2);
    // A blank cell is the parser's own empty-inline shape, not a bare `[]` —
    // see emptyInline's comment in block-editor.ts.
    expect(withRow.rows[0]).toEqual([[{ type: "text", value: "" }], [{ type: "text", value: "" }]]);
    expect(removeTableRow(withRow, 0).rows).toEqual(t.rows);
  });

  it("insertTableColumn / removeTableColumn keep every row the same width", () => {
    const t = table("| A | B |\n| --- | --- |\n| 1 | 2 |");
    const withCol = insertTableColumn(t, 1);
    expect(withCol.header).toHaveLength(3);
    expect(withCol.rows[0]).toHaveLength(3);
    expect(withCol.align).toHaveLength(3);
    expect(removeTableColumn(withCol, 1)).toEqual(t);
  });

  it("removeTableColumn refuses to drop the last column", () => {
    const t = table("| Only |\n| --- |\n| 1 |");
    expect(removeTableColumn(t, 0)).toBe(t);
  });
});

// --- new-block factories ---------------------------------------------------------

describe("new-block factories", () => {
  it("produce blocks that serialize and re-parse cleanly", () => {
    const factories: MaterialBlock[] = [
      newParagraphBlock("New paragraph"),
      newListBlock("New item"),
      newCalloutBlock("tip"),
      newTableBlock(),
      newDividerBlock(),
    ];
    for (const b of factories) {
      expect(parseBlockText(serializeBlock(b))).toEqual([b]);
    }
  });

  it("newListBlock starts with one uncheckable item", () => {
    const l = newListBlock("New item") as ListBlock;
    expect(l.items).toHaveLength(1);
    expect(l.items[0].checked).toBeNull();
  });

  it("newCalloutBlock takes the requested variant with no title or body", () => {
    const c = newCalloutBlock("homework") as CalloutBlock;
    expect(c.variant).toBe("homework");
    expect(c.title).toBeNull();
    expect(c.blocks).toEqual([]);
  });

  it("newTableBlock is a 2x2 starter grid", () => {
    const t = newTableBlock() as TableBlock;
    expect(t.header).toHaveLength(2);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toHaveLength(2);
  });
});

describe("single-line field guards", () => {
  it("collapses pasted newlines in an item head, a callout title, and a table cell", () => {
    const list = newListBlock("start") as ListBlock;
    const edited = updateListItemText(list, 0, "line one\nline two");
    expect(edited.items[0].inlines).toEqual([{ type: "text", value: "line one line two" }]);

    const callout = newCalloutBlock("tip") as CalloutBlock;
    const titled = updateCalloutTitle(callout, "title\r\nwrapped");
    expect(titled.title).toEqual([{ type: "text", value: "title wrapped" }]);

    const table = newTableBlock() as TableBlock;
    const celled = updateTableCell(table, 0, 0, "a\nb");
    expect(celled.rows[0][0]).toEqual([{ type: "text", value: "a b" }]);
  });

  it("never removes a list's last item — the block would silently evaporate", () => {
    const list = newListBlock("only") as ListBlock;
    expect(removeListItem(list, 0)).toBe(list);
    const two = insertListItem(list, 1, "second");
    expect(removeListItem(two, 0).items).toHaveLength(1);
  });
});
