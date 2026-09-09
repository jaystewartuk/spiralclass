import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// SSR checks for the section editor (MATERIAL_EDITING phases 2 and 4). The
// behavioural core — reorder/delete/undo/AI-splice at the section level, and
// every block op one level down — is unit-tested against the pure shared
// modules (editor.test.ts, block-editor.test.ts in @spiralclass/shared);
// what's pinned here is the chrome the teacher actually clicks, and that a
// card's content renders through structured per-block editors (block-editor.tsx)
// rather than a raw Markdown dump. Radix's Select portals its option list, which
// `renderToStaticMarkup` never renders — so callout-variant assertions here
// check the trigger (rendered) rather than the option list (portaled, not
// present in this SSR snapshot at all).

vi.mock("@/app/actions/library", () => ({
  refineMaterialDraftAction: vi.fn(),
}));
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "es-MX",
}));

const { MaterialEditor } = await import("@/components/materials/material-editor");

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
].join("\n");

function html(props: Partial<React.ComponentProps<typeof MaterialEditor>> = {}): string {
  return renderToStaticMarkup(
    React.createElement(MaterialEditor, { body: DOC, onChange: () => {}, ...props }),
  );
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("MaterialEditor — section cards", () => {
  it("renders one card per part, titled by its heading", () => {
    const out = html();
    expect(out).toContain("Lesson plan");
    expect(out).toContain("1. Warm-up");
    expect(out).toContain("2. Practice");
    // Three sections → three card regions.
    expect(count(out, "<section")).toBe(3);
  });

  it("renders each card's content preview-first, not a raw Markdown dump or open editors", () => {
    const out = html();
    // Read mode goes through the same student-facing renderer
    // (MaterialDocument) — never a second, drifting one, and never raw
    // Markdown text.
    expect(out).toContain("material-document");
    expect(out).toContain(">An intro paragraph.<");
    // Preview-first (Phase 5): no block renders an open editor until tapped —
    // the callout shows its rendered form (title + body), never its editor
    // chrome or the raw `> [!exercise]` marker text.
    expect(out).not.toContain("<textarea");
    expect(out).not.toContain('aria-label="material.editor.block.calloutVariantLabel"');
    expect(out).toContain("Drill");
    expect(out).not.toContain("&gt; [!exercise]");
    expect(out).not.toContain("[!exercise]");
    // Every block is an activatable read region for tap-to-edit.
    expect(out).toContain('aria-label="material.editor.block.editThis"');
    // The callout's nested body renders too, inside the same read region.
    expect(out).toContain("Repeat after me.");
  });

  it("gives every card move / duplicate / delete chrome", () => {
    const out = html();
    expect(count(out, "material.editor.moveUp")).toBeGreaterThanOrEqual(3);
    expect(count(out, "material.editor.moveDown")).toBeGreaterThanOrEqual(3);
    expect(count(out, "material.editor.duplicate")).toBeGreaterThanOrEqual(3);
    expect(count(out, "material.editor.delete")).toBeGreaterThanOrEqual(3);
  });

  it("offers an add-section affordance above the first card and after every card", () => {
    // N cards → N+1 slots to insert into.
    expect(count(html(), "material.editor.addSectionHere")).toBe(4);
  });

  it("labels a pre-heading lead section instead of leaving the card nameless", () => {
    const out = html({ body: "Loose prose.\n\n## A\n\nx\n\n## B\n\ny" });
    expect(out).toContain("material.editor.leadSection");
  });

  it("shows no undo affordance until something has been changed", () => {
    expect(html()).not.toContain("material.editor.undo");
  });

  it("shows no AI-change banner until a refine has actually happened", () => {
    // `material.editor.undo` above already covers `undoAiChange` by prefix;
    // the banner's own label key is a separate string, checked explicitly.
    expect(html()).not.toContain("material.editor.aiSectionChanged");
  });
});

describe("MaterialEditor — per-section AI refine", () => {
  it("offers a per-section refine on every card when AI authoring is available", () => {
    const out = html({ canRefine: true });
    expect(count(out, "material.editor.refineSection")).toBeGreaterThanOrEqual(3);
  });

  it("hides it entirely when AI authoring is off (no creds, or a Free plan)", () => {
    expect(html({ canRefine: false })).not.toContain("material.editor.refineSection");
  });
});

describe("MaterialEditor — sole-card delete guard", () => {
  it("disables Delete when only one card remains", () => {
    // Deleting the last card would empty the body and unmount the editor —
    // undo stack (the only recovery for an unsaved draft) included.
    const out = renderToStaticMarkup(
      React.createElement(MaterialEditor, {
        body: "## Only part\n\nAll the content.",
        onChange: () => {},
      }),
    );
    const deleteButton = out
      .split("<button")
      .find((chunk) => chunk.includes('aria-label="material.editor.delete"'));
    expect(deleteButton).toBeDefined();
    // The boolean attribute, not the Tailwind `disabled:` variant classes.
    expect(deleteButton?.slice(0, deleteButton.indexOf(">"))).toContain('disabled=""');
  });

  it("keeps Delete enabled when several cards exist", () => {
    const out = html();
    const deleteButtons = out
      .split("<button")
      .filter((chunk) => chunk.includes('aria-label="material.editor.delete"'));
    expect(deleteButtons.length).toBe(3);
    for (const chunk of deleteButtons) {
      expect(chunk.slice(0, chunk.indexOf(">"))).not.toContain('disabled=""');
    }
  });
});
