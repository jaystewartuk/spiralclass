import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// The searchable multi-select that replaced the always-expanded focus-tag pill
// grid. SSR-level checks: the collapsed trigger reflects the selection count,
// and every selected tag renders as its own removable chip (the dropdown panel
// itself is closed on first render, so only trigger + chips are asserted here).

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "es-MX",
}));

const { FocusTagSelect } = await import("@/components/focus-tags/focus-tag-select");

const groups = [
  {
    categoryId: "c1",
    categoryLabel: "Grammar",
    tags: [
      { id: "t1", label: "Past tense" },
      { id: "t2", label: "Articles" },
    ],
  },
  { categoryId: "c2", categoryLabel: "Level", tags: [{ id: "t3", label: "A2" }] },
];

function render(selected: Set<string>) {
  return renderToStaticMarkup(
    React.createElement(FocusTagSelect, { groups, selected, onToggle: () => {} }),
  );
}

describe("FocusTagSelect", () => {
  it("shows the add-tags placeholder and no chips when nothing is selected", () => {
    const html = render(new Set());
    expect(html).toContain("classContent.author.focusAdd");
    expect(html).not.toContain("classContent.author.focusSelectedCount");
    // No removable-chip aria-labels when the selection is empty.
    expect(html).not.toContain("classContent.author.focusRemove");
  });

  it("renders a removable chip per selected tag and a selected-count trigger", () => {
    const html = render(new Set(["t1", "t3"]));
    expect(html).toContain("classContent.author.focusSelectedCount");
    // Selected tag labels appear as chips…
    expect(html).toContain("Past tense");
    expect(html).toContain("A2");
    // …each with a remove affordance.
    expect(html).toContain("classContent.author.focusRemove");
    // An unselected tag is not shown as a chip (panel is closed on SSR).
    expect(html).not.toContain("Articles");
  });

  it("renders nothing when there are no tag groups", () => {
    const html = renderToStaticMarkup(
      React.createElement(FocusTagSelect, {
        groups: [],
        selected: new Set<string>(),
        onToggle: () => {},
      }),
    );
    expect(html).toBe("");
  });
});
