import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// The Collapsible disclosure that hides a long content preview so Save stays
// reachable (material edit). SSR-level checks pin its two invariants: the
// initial open state follows `defaultOpen`, and children are rendered into the
// DOM either way (hidden via attribute, not unmounted) so a form field wrapped
// inside it still posts.

const { Collapsible } = await import("@/components/ui/collapsible");

function render(defaultOpen: boolean) {
  return renderToStaticMarkup(
    React.createElement(Collapsible, {
      title: "Section",
      defaultOpen,
      children: React.createElement("p", null, "inner-child"),
    }),
  );
}

describe("Collapsible", () => {
  it("starts expanded when defaultOpen is true", () => {
    const html = render(true);
    expect(html).toContain('aria-expanded="true"');
    // Region is visible (no boolean `hidden` attribute on the content region;
    // the chevron's aria-hidden is unrelated).
    expect(html).not.toContain('hidden=""');
    expect(html).toContain("inner-child");
  });

  it("starts collapsed when defaultOpen is false, but keeps children mounted", () => {
    const html = render(false);
    expect(html).toContain('aria-expanded="false"');
    // Collapsed region is hidden via the boolean attribute, not by unmounting —
    // so a wrapped form field still exists in the DOM and posts.
    expect(html).toContain('hidden=""');
    expect(html).toContain("inner-child");
  });
});
