// @vitest-environment jsdom
//
// The help centre's search field, as a reader actually drives it: type, see
// results, walk them with the keyboard, dismiss. The matcher itself is covered
// by src/lib/help/search.test.ts — what is asserted here is the behaviour that
// only exists once the component is mounted, and that a snapshot of the markup
// would not catch: that Escape gets you out, that ArrowDown moves focus into
// the list rather than merely styling something, and that the result count
// reaches a screen reader.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useLocale: () => "en",
}));

import { HelpSearch } from "@/components/help/help-search";
import { anchorLinkResolver, prepareHelpGuides } from "@/lib/help/guides";
import { buildHelpSearchEntries } from "@/lib/help/search";
import type { ContentDoc } from "@spiralclass/shared";

const DOCS: ContentDoc[] = [
  {
    slug: "packages-and-payments",
    audience: "teacher",
    title: { en: "Create packages and manage payments" },
    summary: { en: "Create lesson offers." },
    body: {
      en: [
        "## Purpose",
        "",
        "Create lesson offers.",
        "",
        "## Questions",
        "",
        "**When does a package expire?** On the expiry date set for that package.",
        "",
        "**What happens after a refund?** The remaining credit is removed.",
      ].join("\n"),
    },
  },
];

const ENTRIES = buildHelpSearchEntries(prepareHelpGuides(DOCS, "en", anchorLinkResolver(DOCS)));

let container: HTMLDivElement;
let root: Root;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<HelpSearch entries={ENTRIES} />);
  });
}

function input(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('input[type="search"]');
  if (!el) throw new Error("no search input");
  return el;
}

function type(value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function results(): HTMLAnchorElement[] {
  return [...container.querySelectorAll<HTMLAnchorElement>('ul[class*="divide-y"] a')];
}

beforeEach(render);
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("HelpSearch", () => {
  it("shows nothing until the reader types", () => {
    expect(results()).toHaveLength(0);
  });

  it("lists matching answers, each linking to the section that holds it", () => {
    type("expire");
    const hrefs = results().map((a) => a.getAttribute("href"));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs[0]).toBe("#guide-packages-and-payments-questions");
  });

  it("announces the number of results politely", () => {
    type("expire");
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain("web.help.search.resultCount");
    expect(status?.textContent).toContain(`"count":${results().length}`);
  });

  it("says so when nothing matches, quoting what was searched for", () => {
    type("zzzznothing");
    expect(results()).toHaveLength(0);
    expect(container.textContent).toContain("web.help.search.noResults");
    expect(container.textContent).toContain("zzzznothing");
  });

  it("moves focus into the list on ArrowDown, and back to the field from the top", () => {
    type("expire");
    press(input(), "ArrowDown");
    expect(document.activeElement).toBe(results()[0]);
    press(results()[0], "ArrowUp");
    expect(document.activeElement).toBe(input());
  });

  it("closes on Escape and clears the field", () => {
    type("expire");
    expect(results().length).toBeGreaterThan(0);
    press(input(), "Escape");
    expect(results()).toHaveLength(0);
    expect(input().value).toBe("");
  });

  it("closes when the reader clicks elsewhere, without losing what they typed", () => {
    type("expire");
    act(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(results()).toHaveLength(0);
    expect(input().value).toBe("expire");
  });
});
