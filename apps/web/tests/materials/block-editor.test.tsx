// @vitest-environment jsdom
//
// Interactive coverage for the per-block editor (Phases 4–5 of
// the material-editing design). block-editor.test.ts in
// @spiralclass/shared already property-tests every op this component
// dispatches through (serializeBlock/parseBlockText round trips, list-item
// reorder, table row/column ops, callout variant/title updates); what's
// pinned here is that the CHROME actually wires up to those ops — and, since
// Phase 5, the preview-first model itself: blocks render as the student sees
// them (no fields, no chrome) until activated; a click/Enter/Space on the
// read region reveals exactly that block's editor; committing returns to
// read mode with focus restored.
//
// No @testing-library/react in this repo — interactive component tests use
// raw react-dom/client (createRoot + act()) with manual DOM querying and
// native event dispatching (see ai-generate-guard.test.ts for the pattern
// this file follows, including the native-setter trick needed to fire
// React's onChange from a programmatic `.value` assignment).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "es-MX",
}));

const { SectionBlockEditor } = await import("@/components/materials/block-editor");
const { editorSections, emptySectionEditorState } = await import("@spiralclass/shared");

const EDIT_THIS = '[aria-label="material.editor.block.editThis"]';

const BODY = [
  "An intro paragraph with [a link](https://example.com).",
  "",
  "- [ ] Buy milk",
  "- [ ] Walk dog",
  "",
  "> [!tip] Note",
  "> Nested text.",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "---",
].join("\n");

// Top-level block order in BODY — read regions appear in this order.
const PARAGRAPH = 0;
const LIST = 1;
const CALLOUT = 2;
const TABLE = 3;
const DIVIDER = 4;

// A tiny stateful wrapper so sequential interactions in one test compound the
// way they would under the real MaterialEditor (which re-renders
// SectionBlockEditor with the newly-committed markdown after every action) —
// a bare, uncontrolled SectionBlockEditor would keep re-deriving its blocks
// from the same fixture markdown every render, so a second click in the same
// test would silently act on stale state instead of the first click's result.
function Harness({
  initialMarkdown,
  onAction,
}: {
  initialMarkdown: string;
  onAction: (action: { kind: string; markdown?: string }) => void;
}) {
  const [markdown, setMarkdown] = React.useState(initialMarkdown);
  const sec = React.useMemo(() => editorSections(emptySectionEditorState(markdown))[0], [markdown]);
  return React.createElement(SectionBlockEditor, {
    section: sec,
    onAction: (action: { kind: string; markdown?: string }) => {
      onAction(action);
      if (action.kind === "editBlocks" && action.markdown !== undefined) {
        setMarkdown(action.markdown);
      }
    },
  });
}

describe("SectionBlockEditor", () => {
  let container: HTMLDivElement;
  let root: Root;
  // Typed with the prop's own signature: vitest 5's bare `vi.fn()` is
  // `Mock<Procedure | Constructable>`, which no longer satisfies a concrete
  // callback prop. Naming the signature also means a changed prop shape
  // fails here rather than passing a wrongly-shaped spy into the component.
  let onAction: Mock<(action: { kind: string; markdown?: string }) => void>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onAction = vi.fn<(action: { kind: string; markdown?: string }) => void>();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    act(() => {
      root.render(React.createElement(Harness, { initialMarkdown: BODY, onAction }));
    });
  }

  function readRegions(): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(EDIT_THIS));
  }

  /** Click a read region to reveal that block's editor. */
  function enterEdit(index: number) {
    const region = readRegions()[index];
    expect(region).toBeTruthy();
    act(() => region.click());
  }

  function lastMarkdown(): string {
    expect(onAction).toHaveBeenCalled();
    const call = onAction.mock.calls[onAction.mock.calls.length - 1][0];
    expect(call.kind).toBe("editBlocks");
    return call.markdown as string;
  }

  function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // useDeferredText re-syncs its local value from the committed prop on every
  // render WHILE UNFOCUSED — so typing has to happen after a real focus (as
  // it always does for an actual user), or the very next render snaps the
  // local edit straight back. jsdom's element.focus()/.blur() dispatch real
  // focus/focusout events, which is what React's onFocus/onBlur delegate to.
  function focusType(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    act(() => el.focus());
    act(() => setValue(el, value));
  }

  function commitBlur(el: HTMLElement) {
    act(() => el.blur());
  }

  function byLabel(label: string): HTMLElement {
    const el = container.querySelector(`[aria-label="${label}"]`);
    if (!el) throw new Error(`no element with aria-label ${label}`);
    return el as HTMLElement;
  }

  // ---------- the preview-first model itself ----------

  it("renders every block in read mode — no fields, no type labels, no chrome", () => {
    render();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toContain("material.editor.block.type.paragraph");
    // The rendered content is the student-facing output.
    expect(container.textContent).toContain("An intro paragraph");
    expect(container.textContent).toContain("Buy milk");
    // Five top-level blocks → five activatable read regions.
    expect(readRegions()).toHaveLength(5);
  });

  it("reveals exactly one editor on click, and only for the clicked block", () => {
    render();
    enterEdit(PARAGRAPH);
    expect(container.querySelectorAll("textarea")).toHaveLength(1);
    // The other blocks stay in read mode (list items would render inputs).
    expect(container.textContent).toContain("material.editor.block.type.paragraph");
    expect(container.textContent).not.toContain("material.editor.block.type.list");
  });

  it("activates a block with Enter and with Space", () => {
    render();
    for (const key of ["Enter", " "]) {
      const region = readRegions()[PARAGRAPH];
      act(() => region.focus());
      act(() => {
        region.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
      expect(container.querySelectorAll("textarea")).toHaveLength(1);
      // Exit again (blur out) so the second key can re-enter from read mode.
      commitBlur(container.querySelector("textarea")!);
      expect(container.querySelector("textarea")).toBeNull();
    }
  });

  it("moves focus into the field on enter and returns it to the read region on Done", () => {
    render();
    enterEdit(PARAGRAPH);
    const textarea = container.querySelector("textarea")!;
    expect(document.activeElement).toBe(textarea);
    const done = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "material.editor.block.done",
    )!;
    act(() => done.click());
    expect(container.querySelector("textarea")).toBeNull();
    const region = readRegions()[PARAGRAPH];
    expect(document.activeElement).toBe(region);
  });

  it("does not enter edit mode when a link inside the block is clicked", () => {
    render();
    const link = container.querySelector("a")!;
    expect(link).toBeTruthy();
    act(() => link.click());
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("clears the edit target on a structural action (delete from edit mode)", () => {
    render();
    enterEdit(DIVIDER);
    expect(container.textContent).toContain("material.editor.block.type.divider");
    // Read-mode blocks carry a hover-delete with the same label — target the
    // one inside the active block's chrome (not inside any read region).
    const del = Array.from(
      container.querySelectorAll<HTMLElement>('[aria-label="material.editor.block.delete"]'),
    ).find((b) => !b.closest(EDIT_THIS))!;
    act(() => del.click());
    // The divider is gone from the committed markdown (the table's own
    // `| --- |` separator row remains) and nothing is left in edit mode.
    expect(lastMarkdown()).not.toMatch(/^---$/m);
    expect(container.textContent).not.toContain("material.editor.block.type.divider");
    expect(readRegions()).toHaveLength(4);
  });

  it("offers a hover-revealed delete on the read region that never enters edit mode", () => {
    render();
    const regions = readRegions();
    const del = regions[DIVIDER].querySelector<HTMLButtonElement>(
      '[aria-label="material.editor.block.delete"]',
    )!;
    expect(del).toBeTruthy();
    act(() => del.click());
    expect(container.querySelector("textarea")).toBeNull();
    expect(readRegions()).toHaveLength(4);
  });

  it("keeps insert slots in the DOM but hover-hidden, except the last one", () => {
    render();
    const slots = Array.from(
      container.querySelectorAll<HTMLElement>('[aria-label="material.editor.block.addHere"]'),
    );
    // One before each block + one after the last = block count + 1.
    expect(slots).toHaveLength(6);
    const hidden = slots.filter((s) => s.closest(".opacity-0") !== null);
    expect(hidden).toHaveLength(5);
    // The trailing slot stays visible so an empty section isn't a dead end.
    expect(slots[slots.length - 1].closest(".opacity-0")).toBeNull();
  });

  // ---------- the editors themselves, reached through read mode ----------

  it("edits a paragraph's text and commits on blur, not on every keystroke", () => {
    render();
    enterEdit(PARAGRAPH);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    focusType(textarea, "An intro paragraph, edited.");
    expect(onAction).not.toHaveBeenCalled();
    commitBlur(textarea);
    expect(lastMarkdown()).toContain("An intro paragraph, edited.");
    // Blur also exits edit mode — the block re-renders as the student sees it.
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("An intro paragraph, edited.");
  });

  it("adds a list item and reflects it in the committed markdown", () => {
    render();
    enterEdit(LIST);
    const addItem = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("material.editor.block.addItem"),
    )!;
    act(() => addItem.click());
    expect(lastMarkdown()).toContain("material.editor.block.itemPlaceholder");
  });

  it("removes a list item", () => {
    render();
    enterEdit(LIST);
    const removeButtons = container.querySelectorAll(
      '[aria-label="material.editor.block.removeItem"]',
    );
    act(() => (removeButtons[0] as HTMLButtonElement).click());
    const md = lastMarkdown();
    expect(md).not.toContain("Buy milk");
    expect(md).toContain("Walk dog");
  });

  it("reorders list items with move-down/move-up", () => {
    render();
    enterEdit(LIST);
    const moveDown = container.querySelectorAll(
      '[aria-label="material.editor.block.moveItemDown"]',
    )[0] as HTMLButtonElement;
    act(() => moveDown.click());
    const md = lastMarkdown();
    expect(md.indexOf("Walk dog")).toBeLessThan(md.indexOf("Buy milk"));
  });

  it("toggles a task-list item's checkbox", () => {
    render();
    enterEdit(LIST);
    const toggle = container.querySelector(
      '[aria-label="material.editor.block.toggleDone"]',
    ) as HTMLElement;
    expect(toggle).not.toBeNull();
    act(() => toggle.click());
    expect(lastMarkdown()).toContain("[x] Buy milk");
  });

  it("edits the callout title and commits on blur", () => {
    render();
    enterEdit(CALLOUT);
    const titleInput = byLabel("material.editor.block.calloutVariantLabel")
      .closest("div")!
      .querySelector(
        'input[placeholder="material.editor.block.calloutTitlePlaceholder"]',
      ) as HTMLInputElement;
    focusType(titleInput, "Updated title");
    commitBlur(titleInput);
    expect(lastMarkdown()).toContain("Updated title");
  });

  it("edits the callout's nested body text (recursive read-first block editor)", () => {
    render();
    enterEdit(CALLOUT);
    // Inside the callout's editor, its own blocks are again read-first.
    expect(container.querySelector("textarea")).toBeNull();
    const nestedRegions = readRegions();
    // The callout itself left read mode, so the remaining regions are the
    // other four top-level blocks + the callout's one nested paragraph.
    expect(nestedRegions).toHaveLength(5);
    const nestedParagraph = nestedRegions.find((r) => r.textContent?.includes("Nested text."))!;
    act(() => nestedParagraph.click());
    const nested = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(nested.value).toContain("Nested text.");
    focusType(nested, "Nested text, edited.");
    commitBlur(nested);
    expect(lastMarkdown()).toContain("Nested text, edited.");
  });

  it("edits a table cell", () => {
    render();
    enterEdit(TABLE);
    const cellInputs = Array.from(container.querySelectorAll("input")).filter(
      (i) => i.value === "1",
    );
    expect(cellInputs.length).toBeGreaterThan(0);
    focusType(cellInputs[0], "42");
    commitBlur(cellInputs[0]);
    expect(lastMarkdown()).toContain("42");
  });

  it("adds a table row and column", () => {
    render();
    enterEdit(TABLE);
    const addRow = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("material.editor.block.addRow"),
    )!;
    act(() => addRow.click());
    const withRow = lastMarkdown();
    const addColumn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("material.editor.block.addColumn"),
    )!;
    act(() => addColumn.click());
    const withColumn = lastMarkdown();
    // Adding a column grows every row (including the header) by one cell —
    // simplest observable signal is more `|` separators in the table lines.
    const pipeCount = (s: string) => (s.match(/\|/g) ?? []).length;
    expect(pipeCount(withColumn)).toBeGreaterThan(pipeCount(withRow));
  });

  it("shows the callout's current variant in the picker trigger", () => {
    // Full Radix Select interaction (open + pick another option) isn't
    // exercised here — its portal + pointer-capture behaviour makes it a
    // poor fit for this raw-DOM harness (see material-editor.test.tsx's
    // header note); `updateCalloutVariant` itself is fully covered in
    // block-editor.test.ts (@spiralclass/shared). What's pinned here is that
    // this component wires the callout's actual variant into the trigger.
    render();
    enterEdit(CALLOUT);
    const trigger = byLabel("material.editor.block.calloutVariantLabel");
    expect(trigger.textContent).toContain("material.callout.tip");
  });

  it("opens the add-block menu and inserts a paragraph", () => {
    render();
    const addTrigger = container.querySelector(
      '[aria-label="material.editor.block.addHere"]',
    ) as HTMLButtonElement;
    act(() => addTrigger.click());
    const paragraphChip = Array.from(container.querySelectorAll("button")).find(
      (b) =>
        b.textContent?.includes("material.editor.block.type.paragraph") &&
        !b.hasAttribute("aria-label"),
    )!;
    act(() => paragraphChip.click());
    expect(lastMarkdown()).toContain("material.editor.block.newParagraphText");
  });

  it("opens the callout submenu inside the add-block menu and inserts a callout", () => {
    render();
    const addTriggers = container.querySelectorAll('[aria-label="material.editor.block.addHere"]');
    const lastAddTrigger = addTriggers[addTriggers.length - 1] as HTMLButtonElement;
    act(() => lastAddTrigger.click());
    const calloutToggle = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("material.editor.block.type.callout"),
    )!;
    act(() => calloutToggle.click());
    // Variant labels resolve through the mocked useT (identity), so a variant
    // chip's text is its raw i18n key, e.g. "material.callout.tip". In read
    // mode nothing else renders that text as a button, so the chip match is
    // unambiguous.
    const tipChip = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("material.callout.tip") && !b.hasAttribute("aria-label"),
    )!;
    act(() => tipChip.click());
    expect(lastMarkdown()).toContain("[!tip]");
    // A second callout now exists — both render in read mode.
    expect(readRegions()).toHaveLength(6);
  });

  it("inserts a timeline from the add-block menu", () => {
    render();
    const addTrigger = container.querySelector(
      '[aria-label="material.editor.block.addHere"]',
    ) as HTMLButtonElement;
    act(() => addTrigger.click());
    const timelineChip = Array.from(container.querySelectorAll("button")).find(
      (b) =>
        b.textContent?.includes("material.editor.block.type.timeline") &&
        !b.hasAttribute("aria-label"),
    )!;
    act(() => timelineChip.click());
    const md = lastMarkdown();
    expect(md).toContain("```timeline");
    // The inserted block has to survive its own round trip — a starter block
    // with nothing on the axis would read back as a code block. See
    // newTimelineBlock's representability guard.
    expect(md).toMatch(/^point \d+$/m);
  });

  // ---------- the timeline block's own editor ----------
  //
  // A timeline never edits as text: its Markdown form is a fence of directives
  // with numeric positions, and one mistyped word makes the parser refuse the
  // whole payload. Every field here goes through the shared ops instead.

  describe("timeline block", () => {
    const TIMELINE_BODY = [
      "```timeline",
      "past Before",
      "now Today",
      "future Later",
      "span 20 50 have lived here",
      "point 20 I moved here",
      "```",
    ].join("\n");

    function renderTimeline() {
      act(() => {
        root.render(React.createElement(Harness, { initialMarkdown: TIMELINE_BODY, onAction }));
      });
      act(() => readRegions()[0].click());
    }

    it("offers no edit-as-text field", () => {
      renderTimeline();
      expect(container.textContent).toContain("material.editor.block.type.timeline");
      expect(container.querySelector("textarea")).toBeNull();
    });

    it("retitles an axis label", () => {
      renderTimeline();
      const field = byLabel("material.editor.block.timelineNowLabel") as HTMLInputElement;
      focusType(field, "Ahora");
      commitBlur(field);
      expect(lastMarkdown()).toContain("now Ahora");
    });

    it("moves a marker along the axis", () => {
      renderTimeline();
      const field = byLabel("material.editor.block.timelinePosition") as HTMLInputElement;
      focusType(field, "80");
      commitBlur(field);
      expect(lastMarkdown()).toContain("point 80 I moved here");
    });

    it("ignores a cleared position rather than snapping the marker to zero", () => {
      renderTimeline();
      const field = byLabel("material.editor.block.timelinePosition") as HTMLInputElement;
      focusType(field, "");
      commitBlur(field);
      expect(onAction).not.toHaveBeenCalled();
    });

    it("adds and removes a marker", () => {
      renderTimeline();
      const add = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("material.editor.block.timelineAddPoint"),
      )!;
      act(() => add.click());
      expect((lastMarkdown().match(/^point /gm) ?? []).length).toBe(2);

      const remove = container.querySelector<HTMLButtonElement>(
        '[aria-label="material.editor.block.timelineRemovePoint"]',
      )!;
      act(() => remove.click());
      expect((lastMarkdown().match(/^point /gm) ?? []).length).toBe(1);
    });

    it("removes and re-adds the highlighted span", () => {
      renderTimeline();
      const remove = byLabel("material.editor.block.timelineRemoveSpan") as HTMLButtonElement;
      act(() => remove.click());
      expect(lastMarkdown()).not.toContain("span ");

      const add = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("material.editor.block.timelineAddSpan"),
      )!;
      act(() => add.click());
      expect(lastMarkdown()).toContain("span 20 50");
    });

    it("cannot empty the timeline: the last marker's delete goes inert", () => {
      act(() => {
        root.render(
          React.createElement(Harness, {
            initialMarkdown: "```timeline\npoint 20 only\n```",
            onAction,
          }),
        );
      });
      act(() => readRegions()[0].click());
      const remove = byLabel("material.editor.block.timelineRemovePoint") as HTMLButtonElement;
      expect(remove.disabled).toBe(true);
      // And the op refuses even if the control were reached anyway.
      act(() => remove.click());
      expect(onAction).not.toHaveBeenCalled();
    });
  });
});
