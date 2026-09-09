import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// The focus-tags settings manager, rendered against the REAL string catalog.
//
// The unit environment is `node` with no jsdom, so this pins the STRUCTURE the
// redesign's claims rest on — the things a type never checks and a screenshot
// never fails on. Behaviour that needs a click (escape discards, delete
// confirms, undo restores) lives in tests/e2e/focus-tags.spec.ts; the pure
// list logic lives in src/lib/focus-tag-editing.test.ts.

// Server actions are only ever invoked from a handler here; importing the real
// module would drag prisma and auth into a view test.
vi.mock("@/app/actions/focus-tags", () => ({
  saveFocusTagsAction: async () => undefined,
  saveFocusCategoriesAction: async () => undefined,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { TagsManager } = await import("@/app/(app)/settings/focus-tags/tags-manager");
const { LocaleProvider } = await import("@/components/locale-provider");

const CATEGORIES = [
  { id: "c1", label: "Grammar" },
  { id: "c2", label: "Vocabulary" },
  { id: "c3", label: "Format" },
];

const tag = (id: string, label: string, categoryId: string) => ({ id, label, categoryId });

const TAGS = [
  tag("t1", "Past tense", "c1"),
  tag("t2", "Subjunctive", "c1"),
  tag("t3", "Food", "c2"),
];

function render(categories = CATEGORIES, tags = TAGS) {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <TagsManager initialCategories={categories} initialTags={tags} />
    </LocaleProvider>,
  );
}

describe("a category is a named section with its own heading", () => {
  const html = render();

  it("names the section BY its heading rather than by a duplicate aria-label", () => {
    // Heading.id + aria-labelledby is the pattern the primitive documents: an
    // aria-label repeating the same words is a second copy that drifts.
    expect(html).toContain('aria-labelledby="focus-category-c1"');
    expect(html).toContain('id="focus-category-c1"');
    expect(html).toContain("<section");
    expect(html).not.toContain('aria-label="Grammar"');
  });

  it("renders the category name as an h2, once, however many tags it holds", () => {
    // The defect the grouped design exists to fix: the old pair of flat forms
    // printed a category's name once per tag row, inside a <Select>.
    expect(html).toMatch(/<h2[^>]*id="focus-category-c1"[^>]*>Grammar<\/h2>/);
    expect(html.match(/>Grammar</g) ?? []).toHaveLength(1);
  });

  it("states each category's tag count in words for a screen reader, not just a digit", () => {
    expect(html).toContain("2 tags");
    expect(html).toContain("1 tag<");
  });

  it("gives every category an edit control named after it", () => {
    expect(html).toContain('aria-label="Edit Grammar"');
    expect(html).toContain('aria-label="Add a tag to Grammar"');
  });
});

describe("hierarchy and targets", () => {
  const html = render();

  it("puts each category in a card rather than leaving the page a wall of chips", () => {
    expect(html).toContain("bg-card");
  });

  it("holds tags in a labelled list so their number is announced", () => {
    expect(html).toContain('aria-label="Tags in Grammar"');
    expect(html).toContain("<ul");
  });

  it("meets the 44px touch floor on the chip and the add control (D-140)", () => {
    // `desktop:` — (min-width: 1024px) and (pointer: fine) — is where they
    // taper. A finger never gets the 36px version.
    expect(html).toContain("min-h-target");
    expect(html).toContain("desktop:min-h-9");
  });

  it("hides the drag handles from touch, where a 14px grip is not a target", () => {
    expect(html).toContain("desktop:flex");
    expect(html).toContain('aria-label="Reorder Grammar. Use the arrow keys to move, or drag');
  });
});

describe("the status line", () => {
  it("is a live region present from first paint, so autosave never shifts the page", () => {
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    // Rendered before anything has been saved: the slot exists, the word does
    // not. The old version mounted and unmounted the whole line.
    expect(html).not.toContain(">Saved<");
  });

  it("counts the taxonomy in pluralised words", () => {
    expect(render()).toContain("3 tags");
    expect(render(CATEGORIES, [TAGS[0]])).toContain("1 tag");
    expect(render([CATEGORIES[0]], [TAGS[0]])).toContain("1 category");
    expect(render()).toContain("3 categories");
  });
});

describe("search", () => {
  it("stays off until there are enough tags for scanning to fail", () => {
    expect(render()).not.toContain('role="search"');
  });

  it("appears once the taxonomy outgrows one screen", () => {
    const many = Array.from({ length: 12 }, (_, i) => tag(`t${i}`, `Tag ${i}`, "c1"));
    const html = render(CATEGORIES, many);
    expect(html).toContain('role="search"');
    expect(html).toContain('placeholder="Search tags"');
  });
});

describe("empty states", () => {
  it("offers the first category rather than a bare line of grey text", () => {
    const html = render([], []);
    expect(html).toContain("No categories yet");
    expect(html).toContain("Add category");
    expect(html).not.toContain("<section");
  });

  it("says a category is empty inside the category itself", () => {
    expect(render(CATEGORIES, [])).toContain("No tags in this category yet.");
  });
});
