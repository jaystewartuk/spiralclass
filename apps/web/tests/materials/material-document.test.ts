import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// SSR-level checks for the shared material document renderer (the web reference
// implementation of the redesign). The parser itself is unit-tested in
// @spiralclass/shared; here we assert the web renderer maps the semantic blocks
// to the right brand-styled markup and holds its sanitisation boundary.

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

const { MaterialDocument } = await import("@/components/materials/material-document");

function html(body: string): string {
  return renderToStaticMarkup(React.createElement(MaterialDocument, { body }));
}

describe("MaterialDocument (web)", () => {
  it("renders headings with the display font", () => {
    const out = html("# Lesson\n## Section");
    expect(out).toContain("<h1");
    expect(out).toContain("<h2");
    expect(out).toContain("font-display");
  });

  it("renders a semantic callout with its localized label", () => {
    const out = html("> [!tip]\n> Practice daily.");
    // The label resolves through useT → the raw key in this mock.
    expect(out).toContain("material.callout.tip");
    expect(out).toContain("Practice daily.");
  });

  it("renders a callout's author-supplied title over the default label", () => {
    const out = html("> [!vocabulary] Key words\n> body");
    expect(out).toContain("Key words");
    expect(out).not.toContain("material.callout.vocabulary");
  });

  it("collapses answer callouts behind a show/hide control", () => {
    const out = html("> [!answer]\n> 42");
    expect(out).toContain("material.answer.show");
    // Collapsed on first render — the answer body is not in the initial markup.
    expect(out).not.toContain(">42<");
  });

  it("renders a checklist with checkbox markers", () => {
    const out = html("- [x] done\n- [ ] todo");
    expect(out).toContain("line-through"); // checked item styling
    expect(out).toContain("done");
    expect(out).toContain("todo");
  });

  it("renders a table respecting column alignment", () => {
    const out = html("| A | B |\n|:--|--:|\n| 1 | 2 |");
    expect(out).toContain("<table");
    expect(out).toContain("text-align:right");
  });

  it("renders safe links but strips a javascript: href to inert text", () => {
    const safe = html("[docs](https://x.test)");
    expect(safe).toContain('href="https://x.test"');
    const unsafe = html("[x](javascript:alert(1))");
    expect(unsafe).not.toContain("javascript:alert");
    expect(unsafe).toContain("x");
  });

  it("never emits a raw HTML sink from body content", () => {
    const out = html("<img src=x onerror=alert(1)>\n\nplain");
    expect(out).not.toContain("<img");
    expect(out).toContain("plain");
  });

  // The tense timeline — the first block the renderer DRAWS rather than
  // typesets. The geometry itself is unit-tested in @spiralclass/shared
  // (timeline-block.test.ts); what's pinned here is that this renderer emits
  // the vector marks and puts every label in real text beside them.
  describe("tense timeline", () => {
    const BODY = [
      "```timeline",
      "past Before",
      "now Today",
      "future Later",
      "span 20 50 have lived here",
      "point 20 I moved to Mérida",
      "```",
    ].join("\n");

    it("draws the axis, the present divider, the span and each marker", () => {
      const out = html(BODY);
      expect(out).toContain("<svg");
      expect(out).toContain("<line"); // axis + now divider
      expect(out).toContain("<polygon"); // the future arrow head
      expect(out).toContain("<rect"); // the highlighted span
      expect(out).toContain("<circle"); // the marker
    });

    it("puts every label in text beside the graphic, not inside it", () => {
      const out = html(BODY);
      // No <text> in the SVG — nothing here can measure a string, so captions
      // live outside it where they wrap and can be read aloud.
      expect(out).not.toContain("<text");
      for (const label of ["Before", "Today", "Later", "have lived here", "I moved to Mérida"]) {
        expect(out).toContain(label);
      }
    });

    it("renders a timeline with no labels at all without a legend", () => {
      const out = html("```timeline\npast\nnow\nfuture\npoint 30\n```");
      expect(out).toContain("<svg");
      expect(out).not.toContain("<ul");
    });

    it("falls back to a code block for a payload the parser refuses", () => {
      const out = html("```timeline\npoint 20 x\nwobble 3\n```");
      expect(out).not.toContain("<svg");
      expect(out).toContain("<pre");
      expect(out).toContain("wobble 3");
    });
  });
});
