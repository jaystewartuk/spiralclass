import { describe, expect, it } from "vitest";
import { parseMaterialDoc } from "./parse";
import { serializeMaterialDoc } from "./serialize";
import {
  adoptBody,
  applySectionAction,
  editorSections,
  emptySectionEditorState,
  hasSection,
  resolveSectionLevel,
  SECTION_UNDO_LIMIT,
  undoSectionAction,
} from "./editor";

// The state core of the section editor (MATERIAL_EDITING phase 2, promoted to
// this package in phase 3 so the mobile section editor drives the identical
// behaviour). The shared section ops (splitSections/moveSection/...) are
// tested in sections.test.ts; what's pinned here is the layer an editor
// component actually drives — card derivation, Markdown-in/out for every
// action, the AI splice, and the in-session undo stack.

const DOC = [
  "# Lesson plan",
  "",
  "An intro paragraph.",
  "",
  "## 1. Warm-up",
  "",
  "Say hello.",
  "",
  "## 2. Practice",
  "",
  "> [!exercise] Drill",
  "> Repeat after me.",
  "",
  "## 3. Homework",
  "",
  "Do page 12.",
].join("\n");

// `editorSections` reads a full editor state (it carries the pinned cut level
// and the stable card ids); these wrap a bare body for the read-only checks.
const cardsOf = (body: string) => editorSections(emptySectionEditorState(body));
const titles = (body: string) => cardsOf(body).map((s) => s.title);

describe("editorSections", () => {
  it("cuts one card per part, keeping the title + preamble as the lead card", () => {
    expect(titles(DOC)).toEqual(["Lesson plan", "1. Warm-up", "2. Practice", "3. Homework"]);
    expect(cardsOf(DOC)[0].markdown).toContain("An intro paragraph.");
  });

  it("gives each card its own serialized Markdown — heading included", () => {
    const [, warmUp] = cardsOf(DOC);
    expect(warmUp.markdown).toBe("## 1. Warm-up\n\nSay hello.");
  });

  it("marks a pre-heading lead section with a null title and level", () => {
    const [lead] = cardsOf("Just some prose.\n\n## A\n\nx\n\n## B\n\ny");
    expect(lead.title).toBeNull();
    expect(lead.level).toBeNull();
  });

  it("returns a single card for a body with no headings at all", () => {
    expect(cardsOf("Only prose here.")).toHaveLength(1);
  });

  it("flattens a formatted heading to plain text for the card label", () => {
    // The card header is a one-line label, so bold/italic/code/link markup in a
    // heading has to collapse rather than leak Markdown into the chrome.
    const body = [
      "## **Bold** and *em* and `code` and [a link](https://x.test)",
      "",
      "x",
      "",
      "## Second",
      "",
      "y",
    ].join("\n");
    expect(titles(body)[0]).toBe("Bold and em and code and a link");
  });

  it("labels an empty heading as untitled rather than as a blank card", () => {
    const [first] = cardsOf("## \n\nx\n\n## B\n\ny");
    expect(first.title).toBeNull();
    expect(first.level).toBe(2);
  });
});

describe("resolveSectionLevel", () => {
  // Without this, a material that numbers its parts with anything other than
  // `##` collapses into one useless card.
  it("cuts at the shallowest level that actually has siblings", () => {
    expect(resolveSectionLevel(parseMaterialDoc("# T\n\n## A\n\n## B"))).toBe(2);
    expect(resolveSectionLevel(parseMaterialDoc("# A\n\n# B"))).toBe(1);
    expect(resolveSectionLevel(parseMaterialDoc("# T\n\n### a\n\n### b"))).toBe(3);
  });

  it("falls back to the shallowest level present, then to 2", () => {
    expect(resolveSectionLevel(parseMaterialDoc("# Only a title"))).toBe(1);
    expect(resolveSectionLevel(parseMaterialDoc("No headings."))).toBe(2);
  });
});

describe("applySectionAction — move", () => {
  it("reorders the cards and renumbers the headings that follow", () => {
    const next = applySectionAction(emptySectionEditorState(DOC), { kind: "move", from: 3, to: 1 });
    // "3. Homework" moved above the other two, so the numbering rewrites itself
    // — the exact edit an AI refine round-trip fumbles.
    expect(titles(next.body)).toEqual(["Lesson plan", "1. Homework", "2. Warm-up", "3. Practice"]);
  });

  it("carries a section's whole body with it", () => {
    const next = applySectionAction(emptySectionEditorState(DOC), { kind: "move", from: 2, to: 1 });
    expect(cardsOf(next.body)[1].markdown).toContain("Repeat after me.");
  });

  it("is a no-op — history included — when nothing would change", () => {
    const state = emptySectionEditorState(DOC);
    expect(applySectionAction(state, { kind: "move", from: 1, to: 1 })).toBe(state);
    expect(applySectionAction(state, { kind: "move", from: 9, to: 0 })).toBe(state);
  });
});

describe("applySectionAction — delete / duplicate / insert", () => {
  it("deletes a section and renumbers the rest", () => {
    const next = applySectionAction(emptySectionEditorState(DOC), { kind: "delete", index: 1 });
    expect(titles(next.body)).toEqual(["Lesson plan", "1. Practice", "2. Homework"]);
    expect(next.body).not.toContain("Say hello.");
  });

  it("duplicates a section directly after itself, body and all", () => {
    const next = applySectionAction(emptySectionEditorState(DOC), { kind: "duplicate", index: 2 });
    expect(titles(next.body)).toEqual([
      "Lesson plan",
      "1. Warm-up",
      "2. Practice",
      "3. Practice",
      "4. Homework",
    ]);
    expect(next.body.match(/Repeat after me\./g)).toHaveLength(2);
  });

  it("inserts an empty titled section at the requested slot", () => {
    const next = applySectionAction(emptySectionEditorState(DOC), {
      kind: "insert",
      index: 2,
      title: "Nueva sección",
    });
    expect(titles(next.body)).toEqual([
      "Lesson plan",
      "1. Warm-up",
      "Nueva sección",
      "2. Practice",
      "3. Homework",
    ]);
    // Inserted at the document's own section level, so it becomes a real card.
    expect(cardsOf(next.body)[2].level).toBe(2);
  });

  it("appends when the insert index is past the end", () => {
    const next = applySectionAction(emptySectionEditorState(DOC), {
      kind: "insert",
      index: 99,
      title: "Cierre",
    });
    expect(titles(next.body).at(-1)).toBe("Cierre");
  });
});

describe("applySectionAction — undo", () => {
  it("restores the exact previous body, one step at a time", () => {
    const start = emptySectionEditorState(DOC);
    const deleted = applySectionAction(start, { kind: "delete", index: 1 });
    const moved = applySectionAction(deleted, { kind: "move", from: 1, to: 2 });

    const back = undoSectionAction(moved);
    expect(back.body).toBe(deleted.body);
    expect(undoSectionAction(back).body).toBe(start.body);
  });

  it("restores deleted content verbatim, not an AI approximation of it", () => {
    const deleted = applySectionAction(emptySectionEditorState(DOC), { kind: "delete", index: 2 });
    expect(deleted.body).not.toContain("Repeat after me.");
    expect(undoSectionAction(deleted).body).toContain("> [!exercise] Drill");
  });

  it("does nothing with an empty history", () => {
    const state = emptySectionEditorState(DOC);
    expect(undoSectionAction(state)).toBe(state);
  });

  it("bounds the stack — it's a mis-click buffer, not version history", () => {
    let state = emptySectionEditorState(DOC);
    for (let i = 0; i < SECTION_UNDO_LIMIT + 5; i++) {
      state = applySectionAction(state, { kind: "duplicate", index: 1 });
    }
    expect(state.history).toHaveLength(SECTION_UNDO_LIMIT);
  });
});

describe("applySectionAction — AI refine splice", () => {
  it("replaces only the refined section, leaving every other one byte-identical", () => {
    const state = emptySectionEditorState(DOC);
    const sections = editorSections(state);
    const next = applySectionAction(state, {
      kind: "refine",
      id: sections[1].id,
      markdown: "## 1. Warm-up\n\nGreet your partner in three ways.",
    });
    expect(editorSections(next)[1].markdown).toContain("Greet your partner");
    expect(editorSections(next)[2].markdown).toBe(sections[2].markdown);
    expect(editorSections(next)[3].markdown).toBe(sections[3].markdown);
    expect(next.body).not.toContain("Say hello.");
  });

  it("follows the card through a move AND the renumbering the move causes", () => {
    // THE in-flight scenario, with only what the component actually has at
    // dispatch time: the teacher asks to refine "2. Practice" (captured: the
    // card's id), then moves it up before the model answers. The move rewrites
    // the heading to "1. Practice" — so neither the dispatch-time markdown nor
    // the dispatch-time index identifies the card any more. The id does.
    const state = emptySectionEditorState(DOC);
    const targetId = editorSections(state)[2].id; // "2. Practice", at dispatch
    const moved = applySectionAction(state, { kind: "move", from: 2, to: 1 });
    expect(editorSections(moved)[1].title).toBe("1. Practice");

    const spliced = applySectionAction(moved, {
      kind: "refine",
      id: targetId,
      markdown: "## 1. Practice\n\nShadow the audio twice.",
    });
    expect(editorSections(spliced)[1].markdown).toContain("Shadow the audio");
    // The section that slid into the dispatch-time INDEX is untouched.
    expect(spliced.body).toContain("Say hello.");
    expect(spliced.body).toContain("Do page 12.");
  });

  it("lands on the right duplicate when two cards have identical content", () => {
    const state = emptySectionEditorState(DOC);
    const duplicated = applySectionAction(state, { kind: "duplicate", index: 2 });
    const copies = editorSections(duplicated).filter((s) => s.markdown.includes("Repeat after me"));
    expect(copies).toHaveLength(2);
    const next = applySectionAction(duplicated, {
      kind: "refine",
      id: copies[1].id, // the SECOND copy
      markdown: "## 3. Practice\n\nOnly the second copy changes.",
    });
    const after = editorSections(next);
    expect(after[2].markdown).toContain("Repeat after me");
    expect(after[3].markdown).toContain("Only the second copy changes");
  });

  it("drops the result — no index guess — when the target card was deleted in flight", () => {
    const state = emptySectionEditorState(DOC);
    const targetId = editorSections(state)[2].id;
    const deleted = applySectionAction(state, { kind: "delete", index: 2 });
    expect(hasSection(deleted, targetId)).toBe(false);

    const next = applySectionAction(deleted, {
      kind: "refine",
      id: targetId,
      markdown: "## 2. Practice\n\nThis must go nowhere.",
    });
    // Same reference back: the caller can tell the refine was discarded.
    expect(next).toBe(deleted);
    expect(next.body).not.toContain("This must go nowhere.");
  });

  it("expands into several cards when the model answers with several parts", () => {
    const state = emptySectionEditorState(DOC);
    const next = applySectionAction(state, {
      kind: "refine",
      id: editorSections(state)[3].id,
      markdown: "## Homework A\n\nPage 12.\n\n## Homework B\n\nPage 13.",
    });
    expect(titles(next.body)).toEqual([
      "Lesson plan",
      "1. Warm-up",
      "2. Practice",
      "Homework A",
      "Homework B",
    ]);
    // The replaced card keeps its id on the first resulting section.
    expect(editorSections(next)[3].id).toBe(editorSections(state)[3].id);
  });

  it("is undoable like any other structural edit", () => {
    const state = emptySectionEditorState(DOC);
    const next = applySectionAction(state, {
      kind: "refine",
      id: editorSections(state)[1].id,
      markdown: "## 1. Warm-up\n\nSomething else.",
    });
    expect(undoSectionAction(next).body).toBe(DOC);
  });
});

describe("stable card identity", () => {
  it("permutes ids with a move, so a card keeps its id wherever it sits", () => {
    const state = emptySectionEditorState(DOC);
    const before = editorSections(state);
    const moved = applySectionAction(state, { kind: "move", from: 3, to: 1 });
    const after = editorSections(moved);
    expect(after[1].id).toBe(before[3].id); // Homework moved up, id came along
    expect(after[2].id).toBe(before[1].id);
    expect(after[3].id).toBe(before[2].id);
  });

  it("gives a duplicate a fresh id and keeps the original's", () => {
    const state = emptySectionEditorState(DOC);
    const before = editorSections(state);
    const next = applySectionAction(state, { kind: "duplicate", index: 2 });
    const after = editorSections(next);
    expect(after[2].id).toBe(before[2].id);
    expect(after[3].id).not.toBe(before[2].id);
    expect(after[4].id).toBe(before[3].id);
  });

  it("restores the matching ids on undo, so cards don't remount", () => {
    const state = emptySectionEditorState(DOC);
    const before = editorSections(state);
    const next = applySectionAction(state, { kind: "delete", index: 1 });
    const back = undoSectionAction(next);
    expect(editorSections(back).map((s) => s.id)).toEqual(before.map((s) => s.id));
  });
});

describe("guards — the document can't be emptied through the section chrome", () => {
  it("refuses to delete the only remaining card", () => {
    const state = emptySectionEditorState("## Only part\n\nAll the content.");
    expect(editorSections(state)).toHaveLength(1);
    expect(applySectionAction(state, { kind: "delete", index: 0 })).toBe(state);
  });

  it("refuses an editBlocks that would empty the only remaining card", () => {
    const state = emptySectionEditorState("## Only part\n\nAll the content.");
    expect(applySectionAction(state, { kind: "editBlocks", index: 0, markdown: "" })).toBe(state);
  });

  it("still lets editBlocks with empty markdown delete one card among several", () => {
    const state = emptySectionEditorState(DOC);
    const next = applySectionAction(state, { kind: "editBlocks", index: 1, markdown: "" });
    expect(titles(next.body)).toEqual(["Lesson plan", "1. Practice", "2. Homework"]);
  });
});

describe("pinned cut level", () => {
  it("keeps cutting at the adopted level when a delete drops the sibling count", () => {
    // `# Title` + two `##` parts cuts at level 2. Deleting one part used to
    // re-resolve the level (no level-2 siblings left, fall back to 1) and
    // collapse every remaining card into one.
    const body = "# Title\n\nIntro.\n\n## Part A\n\na\n\n## Part B\n\nb";
    const state = emptySectionEditorState(body);
    expect(editorSections(state).map((s) => s.title)).toEqual(["Title", "Part A", "Part B"]);
    const next = applySectionAction(state, { kind: "delete", index: 1 });
    expect(editorSections(next).map((s) => s.title)).toEqual(["Title", "Part B"]);
  });
});

describe("applySectionAction — editBlocks (direct per-block edit, phase 4)", () => {
  const sections = cardsOf(DOC);

  it("replaces only the edited section, leaving every other one byte-identical", () => {
    const next = applySectionAction(emptySectionEditorState(DOC), {
      kind: "editBlocks",
      index: 1,
      markdown: "## 1. Warm-up\n\nGreet your partner in three ways.",
    });
    expect(cardsOf(next.body)[1].markdown).toContain("Greet your partner");
    expect(cardsOf(next.body)[2].markdown).toBe(sections[2].markdown);
    expect(cardsOf(next.body)[3].markdown).toBe(sections[3].markdown);
    expect(next.body).not.toContain("Say hello.");
  });

  it("unlike refine, addresses the section by the CURRENT index only — no content re-location", () => {
    // A direct edit is synchronous: the index is always current at dispatch,
    // so it needs no `previous` field the way an in-flight AI refine does.
    const next = applySectionAction(emptySectionEditorState(DOC), {
      kind: "editBlocks",
      index: 2,
      markdown: "## 2. Practice\n\nRewritten practice body.",
    });
    expect(cardsOf(next.body)[2].markdown).toContain("Rewritten practice body");
  });

  it("is undoable, and its own history entry is labeled distinctly from an AI refine", () => {
    const next = applySectionAction(emptySectionEditorState(DOC), {
      kind: "editBlocks",
      index: 1,
      markdown: "## 1. Warm-up\n\nEdited directly.",
    });
    expect(next.history[0].kind).toBe("editBlocks");
    expect(undoSectionAction(next).body).toBe(DOC);
  });

  it("expands into several cards when the edited section's text opens a new heading", () => {
    const next = applySectionAction(emptySectionEditorState(DOC), {
      kind: "editBlocks",
      index: 3,
      markdown: "## Homework A\n\nPage 12.\n\n## Homework B\n\nPage 13.",
    });
    expect(titles(next.body)).toEqual([
      "Lesson plan",
      "1. Warm-up",
      "2. Practice",
      "Homework A",
      "Homework B",
    ]);
  });
});

describe("save serialization", () => {
  // The save path is unchanged (serialize → saveMaterialContentAction →
  // validateClassContentBody → revision snapshot → homework auto-draft), which
  // only holds if what the editor hands back is the same Markdown dialect the
  // parser reads.
  it("hands back Markdown that round-trips through the parser", () => {
    const next = applySectionAction(emptySectionEditorState(DOC), { kind: "move", from: 1, to: 3 });
    // The serializer's contract: re-serializing what the editor produced is a
    // fixed point, so a second save never silently rewrites the body again.
    expect(serializeMaterialDoc(parseMaterialDoc(next.body))).toBe(next.body);
  });

  it("preserves semantic callouts through a structural edit — the homework auto-draft depends on them", () => {
    const withHomework = [DOC, "", "> [!homework] Tarea", "> Escribe cinco frases."].join("\n");
    const next = applySectionAction(emptySectionEditorState(withHomework), {
      kind: "move",
      from: 1,
      to: 2,
    });
    expect(next.body).toContain("> [!homework] Tarea");
    expect(next.body).toContain("> [!exercise] Drill");
  });

  it("normalizes the stored Markdown on the first structural edit", () => {
    // Serializing a parsed tree is also a normalizer (`*` bullets → `-`,
    // `__strong__` → `**strong**`). That's expected, and is what the revision
    // snapshot on save covers.
    const messy = "# Title\n\n* one\n* two\n\n## A\n\n__bold__ x\n\n## B\n\ny";
    const next = applySectionAction(emptySectionEditorState(messy), {
      kind: "move",
      from: 1,
      to: 2,
    });
    expect(next.body).toContain("- one");
    expect(next.body).toContain("**bold**");
  });
});

describe("adoptBody", () => {
  it("drops an undo stack that describes a different document", () => {
    const edited = applySectionAction(emptySectionEditorState(DOC), { kind: "delete", index: 1 });
    expect(edited.history).toHaveLength(1);
    const adopted = adoptBody(edited, "# A whole-document refine result");
    expect(adopted.body).toBe("# A whole-document refine result");
    expect(adopted.history).toEqual([]);
  });

  it("is identity when the body is unchanged — the editor's own edits come back to it", () => {
    const edited = applySectionAction(emptySectionEditorState(DOC), { kind: "delete", index: 1 });
    expect(adoptBody(edited, edited.body)).toBe(edited);
  });
});
