import { describe, expect, it } from "vitest";
import {
  CLASS_CONTENT_MAX_CHARS,
  CLASS_CONTENT_TEMPLATE_LABEL_MAX_CHARS,
} from "@/lib/materials/config";
import {
  duplicateLabel,
  isLabelAtLimit,
  pendingChanges,
  templateExcerpt,
  templateOutline,
  templateRowIssue,
  templateRowIssues,
  type EditorRow,
  type TemplateDraft,
} from "@/lib/materials/template-editor";

const row = (over: Partial<EditorRow> = {}): EditorRow => ({
  localKey: over.localKey ?? over.id ?? "k",
  id: "",
  label: "Module",
  body: "## Welcome",
  keep: true,
  ...over,
});

describe("templateOutline", () => {
  it("lists ATX headings in order, at every level", () => {
    expect(
      templateOutline("# Welcome\ntext\n## Objective\n### Grammar\nmore\n###### Reflection"),
    ).toEqual(["Welcome", "Objective", "Grammar", "Reflection"]);
  });

  it("strips the inline Markdown a heading carries", () => {
    expect(templateOutline("## **Bienvenida**\n## [Repaso](https://x.test)\n## `Tarea`")).toEqual([
      "Bienvenida",
      "Repaso",
      "Tarea",
    ]);
  });

  it("drops the closing hashes of a balanced ATX heading", () => {
    expect(templateOutline("## Objective ##")).toEqual(["Objective"]);
  });

  it("ignores hashes inside a fenced code block", () => {
    const body = ["## Real section", "```", "# not a section", "```", "## Another"].join("\n");
    expect(templateOutline(body)).toEqual(["Real section", "Another"]);
  });

  it("ignores hashes inside a tilde-fenced block too", () => {
    expect(templateOutline("~~~\n# hidden\n~~~\n## Shown")).toEqual(["Shown"]);
  });

  it("reads setext headings, and does not repeat the underlined line", () => {
    expect(templateOutline("Welcome\n=======\n\nObjective\n---------")).toEqual([
      "Welcome",
      "Objective",
    ]);
  });

  it("does not treat a hash without a space as a heading", () => {
    expect(templateOutline("#hashtag\n## Real")).toEqual(["Real"]);
  });

  it("normalises CRLF bodies", () => {
    expect(templateOutline("## One\r\n## Two")).toEqual(["One", "Two"]);
  });

  it("is empty for a body with no headings", () => {
    expect(templateOutline("just some prose\nand more prose")).toEqual([]);
  });
});

describe("templateExcerpt", () => {
  it("returns the first line of readable prose", () => {
    expect(templateExcerpt("\n\n  Start with a warm greeting.\nThen the objective.")).toBe(
      "Start with a warm greeting.",
    );
  });

  it("strips a leading list marker", () => {
    expect(templateExcerpt("- Greet the student")).toBe("Greet the student");
    expect(templateExcerpt("1. Greet the student")).toBe("Greet the student");
  });

  it("skips a fenced block rather than quoting code", () => {
    expect(templateExcerpt("```\ncode line\n```\nreal prose")).toBe("real prose");
  });

  it("truncates with an ellipsis past the limit", () => {
    const excerpt = templateExcerpt("a".repeat(200), 20);
    expect(excerpt).toHaveLength(20);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("is empty for an empty body", () => {
    expect(templateExcerpt("   \n\n  ")).toBe("");
  });
});

describe("templateRowIssue", () => {
  it("accepts a complete row", () => {
    expect(templateRowIssue(row())).toBeNull();
  });

  it("rejects a name that is only whitespace", () => {
    expect(templateRowIssue(row({ label: "   " }))).toBe("name-missing");
  });

  it("rejects a body that is only whitespace", () => {
    expect(templateRowIssue(row({ body: "\n \n" }))).toBe("body-missing");
  });

  it("rejects a body past the ceiling", () => {
    expect(templateRowIssue(row({ body: "x".repeat(CLASS_CONTENT_MAX_CHARS + 1) }))).toBe(
      "body-too-long",
    );
  });

  it("accepts a body exactly at the ceiling", () => {
    expect(templateRowIssue(row({ body: "x".repeat(CLASS_CONTENT_MAX_CHARS) }))).toBeNull();
  });

  it("measures the body the server will store, not the raw text", () => {
    // The server trims before it measures, so trailing whitespace that pushes
    // the raw string over the ceiling must not block a submission the server
    // would accept.
    const body = `${"x".repeat(CLASS_CONTENT_MAX_CHARS)}\n\n   `;
    expect(templateRowIssue(row({ body }))).toBeNull();
  });

  it("ignores a row the teacher has removed", () => {
    expect(templateRowIssue(row({ label: "", body: "", keep: false }))).toBeNull();
  });

  it("collects issues by localKey", () => {
    const issues = templateRowIssues([
      row({ localKey: "a" }),
      row({ localKey: "b", label: "" }),
      row({ localKey: "c", body: " " }),
    ]);
    expect([...issues.entries()]).toEqual([
      ["b", "name-missing"],
      ["c", "body-missing"],
    ]);
  });
});

describe("isLabelAtLimit", () => {
  it("is true only once the name fills the column", () => {
    expect(isLabelAtLimit("x".repeat(CLASS_CONTENT_TEMPLATE_LABEL_MAX_CHARS - 1))).toBe(false);
    expect(isLabelAtLimit("x".repeat(CLASS_CONTENT_TEMPLATE_LABEL_MAX_CHARS))).toBe(true);
  });
});

describe("pendingChanges", () => {
  const initial: TemplateDraft[] = [
    { id: "1", label: "One", body: "## One" },
    { id: "2", label: "Two", body: "## Two" },
    { id: "3", label: "Three", body: "## Three" },
  ];
  const asRows = (drafts: TemplateDraft[]): EditorRow[] =>
    drafts.map((d) => ({ ...d, keep: true, localKey: d.id }));

  it("reports nothing pending for an untouched list", () => {
    expect(pendingChanges(initial, asRows(initial))).toMatchObject({
      added: 0,
      edited: 0,
      removed: 0,
      reordered: false,
      count: 0,
      dirty: false,
    });
  });

  it("counts an added row", () => {
    const rows = [...asRows(initial), row({ localKey: "new-1", id: "" })];
    expect(pendingChanges(initial, rows)).toMatchObject({ added: 1, count: 1, dirty: true });
  });

  it("does not count a row added and then removed in the same session", () => {
    const rows = [...asRows(initial), row({ localKey: "new-1", id: "", keep: false })];
    expect(pendingChanges(initial, rows)).toMatchObject({ added: 0, count: 0, dirty: false });
  });

  it("counts an edited label and an edited body once each", () => {
    const rows = asRows(initial);
    rows[0] = { ...rows[0], label: "One renamed" };
    rows[1] = { ...rows[1], body: "## Two, rewritten" };
    expect(pendingChanges(initial, rows)).toMatchObject({ edited: 2, count: 2, dirty: true });
  });

  it("counts a removed existing row", () => {
    const rows = asRows(initial);
    rows[1] = { ...rows[1], keep: false };
    expect(pendingChanges(initial, rows)).toMatchObject({ removed: 1, count: 1, dirty: true });
  });

  it("flags a reorder as a boolean rather than one change per moved row", () => {
    const rows = asRows(initial);
    const moved = [rows[2], rows[0], rows[1]];
    expect(pendingChanges(initial, moved)).toMatchObject({
      count: 0,
      reordered: true,
      dirty: true,
    });
  });

  it("does not call a removal a reorder", () => {
    // Deleting the middle row leaves 1 and 3 in their original relative order.
    const rows = asRows(initial);
    rows[1] = { ...rows[1], keep: false };
    expect(pendingChanges(initial, rows).reordered).toBe(false);
  });

  it("ignores an id the server never confirmed", () => {
    const rows = [...asRows(initial), row({ localKey: "ghost", id: "gone" })];
    expect(pendingChanges(initial, rows)).toMatchObject({
      added: 0,
      edited: 0,
      removed: 0,
      count: 0,
    });
  });
});

describe("duplicateLabel", () => {
  it("appends the first free number", () => {
    expect(duplicateLabel("Module", ["Module"])).toBe("Module (2)");
  });

  it("skips numbers already taken", () => {
    expect(duplicateLabel("Module", ["Module", "Module (2)", "Module (3)"])).toBe("Module (4)");
  });

  it("increments an existing copy rather than nesting suffixes", () => {
    expect(duplicateLabel("Module (2)", ["Module", "Module (2)"])).toBe("Module (3)");
  });

  it("matches names case- and whitespace-insensitively", () => {
    expect(duplicateLabel("Module", ["  module (2)  "])).toBe("Module (3)");
  });

  it("clamps to the length the column will store", () => {
    const long = "x".repeat(CLASS_CONTENT_TEMPLATE_LABEL_MAX_CHARS);
    expect(duplicateLabel(long, [long]).length).toBeLessThanOrEqual(
      CLASS_CONTENT_TEMPLATE_LABEL_MAX_CHARS,
    );
  });
});
