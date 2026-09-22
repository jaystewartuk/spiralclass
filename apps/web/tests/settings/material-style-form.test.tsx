// @vitest-environment jsdom
//
// Interactive coverage for the AI material style form (D-78 + D-80).
//
// Three things here are easy to break and invisible when they are:
//
//  1. The vocabulary dial SHOWS "everyday" while the column is still null,
//     because that is what null resolves to at generation time. It must still
//     POST "" until the teacher picks — otherwise merely opening the page and
//     saving something else pins every teacher to today's global default.
//  2. Each dial is one tab stop with arrow-key movement (a real radiogroup),
//     not five tab stops with no keyboard way to answer.
//  3. Save is gated on there being something to save, and the effect line under
//     each dial tracks the selection — the whole reason the page is legible.
//
// No @testing-library/react in this repo — raw react-dom/client + act(), the
// pattern tests/materials/block-editor.test.tsx follows.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import type { MaterialStyleSettings } from "@spiralclass/shared";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("@/app/actions/profile", () => ({
  saveMaterialStyleAction: vi.fn(async () => ({ ok: true })),
}));

const { MaterialStyleForm } = await import("@/app/(app)/settings/materials/material-style-form");

const UNSET: MaterialStyleSettings = {
  tone: null,
  learnerAge: null,
  languageVariety: null,
  customInstructions: null,
  vocabulary: null,
};

let container: HTMLDivElement;
let root: Root;

function render(initial: MaterialStyleSettings = UNSET) {
  act(() => {
    root.render(
      React.createElement(MaterialStyleForm, { initial, targetLanguageLabel: "Spanish" }),
    );
  });
}

/** The hidden input a segmented dial posts through. */
function posted(name: string): string {
  const input = container.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`);
  if (!input) throw new Error(`no hidden input named ${name}`);
  return input.value;
}

function group(name: string): HTMLElement {
  const input = container.querySelector(`input[type="hidden"][name="${name}"]`);
  const el = input?.parentElement?.querySelector<HTMLElement>('[role="radiogroup"]');
  if (!el) throw new Error(`no radiogroup for ${name}`);
  return el;
}

function radios(name: string): HTMLButtonElement[] {
  return Array.from(group(name).querySelectorAll<HTMLButtonElement>('[role="radio"]'));
}

function checked(name: string): HTMLButtonElement {
  const found = radios(name).find((b) => b.getAttribute("aria-checked") === "true");
  if (!found) throw new Error(`nothing checked in ${name}`);
  return found;
}

function submitButton(): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const found = buttons.find((b) => b.getAttribute("type") === "submit");
  if (!found) throw new Error("no submit button");
  return found;
}

function press(el: HTMLElement, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("MaterialStyleForm — vocabulary (D-80) on web", () => {
  it("shows everyday for a null column but posts nothing, so an untouched row stays null", () => {
    render();
    expect(checked("vocabulary").textContent).toBe("web.settings.materialStyle.vocab.everyday");
    expect(posted("vocabulary")).toBe("");
  });

  it("posts the value once the teacher picks one", () => {
    render();
    act(() => {
      radios("vocabulary")[0]!.click(); // basic
    });
    expect(posted("vocabulary")).toBe("basic");
    expect(checked("vocabulary").textContent).toBe("web.settings.materialStyle.vocab.basic");
  });

  it("posts a stored value back unchanged, so a web save can't wipe a mobile-set one", () => {
    render({ ...UNSET, vocabulary: "native" });
    expect(posted("vocabulary")).toBe("native");
    expect(submitButton().disabled).toBe(true);
  });

  it("has no automatic option — null and everyday are one answer, not two", () => {
    render();
    expect(radios("vocabulary").map((b) => b.textContent)).toEqual([
      "web.settings.materialStyle.vocab.basic",
      "web.settings.materialStyle.vocab.everyday",
      "web.settings.materialStyle.vocab.advanced",
      "web.settings.materialStyle.vocab.native",
    ]);
  });
});

describe("MaterialStyleForm — dials are real radio groups", () => {
  it("gives each group exactly one tab stop, on the selected option", () => {
    render({ ...UNSET, tone: "neutral" });
    const stops = radios("tone").filter((b) => b.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(checked("tone"));
  });

  it("moves the selection with the arrow keys, and wraps at the ends", () => {
    render();
    // Starts on "" (automatic), the first option.
    expect(posted("tone")).toBe("");
    press(checked("tone"), "ArrowRight");
    expect(posted("tone")).toBe("casual");
    press(checked("tone"), "ArrowLeft");
    expect(posted("tone")).toBe("");
    press(checked("tone"), "ArrowLeft");
    expect(posted("tone")).toBe("academic"); // wrapped to the last
    press(checked("tone"), "Home");
    expect(posted("tone")).toBe("");
    press(checked("tone"), "End");
    expect(posted("tone")).toBe("academic");
  });

  it("names each group by its heading and describes it by its effect line", () => {
    render();
    for (const name of ["tone", "learnerAge", "vocabulary"]) {
      const labelledBy = group(name).getAttribute("aria-labelledby");
      const describedBy = group(name).getAttribute("aria-describedby");
      // Attribute selector, not `#id`: useId() ids contain colons, and this
      // jsdom has no CSS.escape.
      expect(container.querySelector(`[id="${labelledBy}"]`)).not.toBeNull();
      expect(container.querySelector(`[id="${describedBy}"]`)).not.toBeNull();
    }
  });

  it("swaps the effect line for the one belonging to the selection", () => {
    render();
    const effectId = group("tone").getAttribute("aria-describedby")!;
    const line = () => container.querySelector(`[id="${effectId}"]`)!.textContent;
    expect(line()).toBe("web.settings.materialStyle.tone.effect.auto");
    act(() => {
      radios("tone")[4]!.click(); // academic
    });
    expect(line()).toBe("web.settings.materialStyle.tone.effect.academic");
  });
});

describe("MaterialStyleForm — saving", () => {
  it("keeps Save disabled until something actually changed", () => {
    render();
    expect(submitButton().disabled).toBe(true);
    act(() => {
      radios("learnerAge")[1]!.click(); // kids
    });
    expect(submitButton().disabled).toBe(false);
    expect(container.textContent).toContain("web.settings.materialStyle.unsaved");
  });

  it("treats whitespace-only edits as clean, because the action trims them", () => {
    render({ ...UNSET, customInstructions: "Keep it concrete." });
    const textarea = container.querySelector<HTMLTextAreaElement>("#customInstructions")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(textarea, "  Keep it concrete.  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(submitButton().disabled).toBe(true);
  });

  it("puts the draft back the way it was when the teacher discards", () => {
    render({ ...UNSET, tone: "friendly" });
    act(() => {
      radios("tone")[4]!.click(); // academic
    });
    expect(posted("tone")).toBe("academic");
    const discard = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "common.discard",
    )!;
    act(() => discard.click());
    expect(posted("tone")).toBe("friendly");
    expect(submitButton().disabled).toBe(true);
  });

  it("names the teacher's own subject in the language-variety hint", () => {
    render();
    expect(container.textContent).toContain("web.settings.materialStyle.variety.hintFor");
    expect(container.textContent).not.toContain("web.settings.materialStyle.variety.hint ");
  });
});
