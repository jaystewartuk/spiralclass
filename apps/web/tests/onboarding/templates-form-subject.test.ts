// @vitest-environment jsdom
//
// D-112: per-package "Subject" is hidden on the onboarding templates step and
// kept at /settings/templates. On a language-first platform the subject is a
// property of the TEACHER (`targetLanguage`, asked at onboarding step 1), so
// asking it again per package before she has a single student is friction that
// only the rare two-language teacher benefits from.
//
// The load-bearing half is that it is only HIDDEN, never cleared: `tpl_subject`
// is still submitted from row state, so a subject set in settings survives an
// onboarding re-save. That is what these tests pin — a future refactor that
// "cleans up" the now-unused visible input by dropping the hidden one too would
// silently wipe every teacher's subjects on her next onboarding save.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// The row renders a Radix Checkbox (the Wise-discount toggle), whose size hook
// wants a ResizeObserver jsdom doesn't implement. Nothing here measures
// anything, so a no-op stub is enough.
(globalThis as Record<string, unknown>).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
}));
vi.mock("@/app/actions/onboarding", () => ({ saveTemplatesAction: vi.fn() }));

const { TemplatesForm } = await import("@/app/(app)/onboarding/templates/templates-form");

const ROW = {
  id: "tpl-1",
  name: "8 clases / 1 mes",
  subject: "Conversation",
  classCount: 8,
  singleClass: false,
  classDurationMin: 50,
  priceMinorUnits: 240000,
  transferPriceMinorUnits: null,
  expirationMonths: 1,
};

function hiddenSubjects(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="tpl_subject"]'),
  ).map((el) => el.value);
}

function visibleSubjectInputs(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('input[id^="subject-"]'));
}

describe("TemplatesForm — subject visibility (D-112)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the subject input by default (/settings/templates)", () => {
    act(() =>
      root.render(
        React.createElement(TemplatesForm, { initial: [ROW], payoutCountrySupported: true }),
      ),
    );
    expect(visibleSubjectInputs(container)).toHaveLength(1);
  });

  it("hides the subject input when showSubject is false (onboarding)", () => {
    act(() =>
      root.render(
        React.createElement(TemplatesForm, {
          initial: [ROW],
          payoutCountrySupported: true,
          showSubject: false,
        }),
      ),
    );
    expect(visibleSubjectInputs(container)).toHaveLength(0);
  });

  it("still submits the existing subject while hidden, so onboarding never wipes it", () => {
    act(() =>
      root.render(
        React.createElement(TemplatesForm, {
          initial: [ROW],
          payoutCountrySupported: true,
          showSubject: false,
        }),
      ),
    );
    expect(hiddenSubjects(container)).toEqual(["Conversation"]);
  });

  it("submits an empty subject as '' rather than dropping the field", () => {
    // The action reads `tpl_subject` with getAll() and index-aligns it against
    // the other per-row arrays — a missing entry would shift every later row's
    // subject onto the wrong package.
    act(() =>
      root.render(
        React.createElement(TemplatesForm, {
          initial: [
            { ...ROW, subject: null },
            { ...ROW, id: "tpl-2" },
          ],
          payoutCountrySupported: true,
          showSubject: false,
        }),
      ),
    );
    expect(hiddenSubjects(container)).toEqual(["", "Conversation"]);
  });
});
