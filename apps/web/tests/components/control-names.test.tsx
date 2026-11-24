// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).React = React;

const { gradeVocabulary } = vi.hoisted(() => ({ gradeVocabulary: vi.fn(async () => undefined) }));
vi.mock("@/app/actions/student-vocab", () => ({ gradeVocabulary }));
vi.mock("@/components/locale-provider", () => ({ useT: () => (key: string) => key }));

const { AccountBadge } = await import("@/components/account-badge");
const { VocabReview } = await import("@/app/(student)/my-classes/progress/vocab-review");

// These controls have no aria-labelledby. Prefer an explicit name if present;
// otherwise read their content, excluding decorative text hidden from AT.
function controlName(element: Element): string {
  const explicit = element.getAttribute("aria-label");
  if (explicit !== null) return explicit;
  const content = element.cloneNode(true) as Element;
  content.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
  return content.textContent ?? "";
}

describe("control names", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("identifies an account even when its visible name is hidden at narrow widths", () => {
    act(() =>
      root.render(
        <AccountBadge name="Alicia Moreno" email="alicia@example.test" nameClassName="hidden" />,
      ),
    );
    const name = controlName(container.querySelector("button")!);
    expect(name).toContain("web.accountBadge.signedInAs");
    expect(name).toContain("Alicia Moreno");
    expect(name).toContain("alicia@example.test");
  });

  it("identifies an email-only account", () => {
    act(() => root.render(<AccountBadge email="alicia@example.test" />));
    expect(controlName(container.querySelector("button")!)).toContain("alicia@example.test");
  });

  it("keeps the localized account fallback when no identity is available", () => {
    act(() => root.render(<AccountBadge />));
    expect(controlName(container.querySelector("button")!)).toContain("web.accountBadge.fallback");
  });

  it("shows a vocabulary card as its term and a recall prompt, with no back to flip to", () => {
    act(() => root.render(<VocabReview terms={[{ id: "v1", term: "bonjour" }]} />));
    expect(container.textContent).toContain("bonjour");
    expect(container.textContent).toContain("progress.flashcard.recall");
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual([
      "progress.grade.again",
      "progress.grade.hard",
      "progress.grade.good",
      "progress.grade.easy",
    ]);
  });

  it("grades the current term and moves on to the next", async () => {
    act(() =>
      root.render(
        <VocabReview
          terms={[
            { id: "v1", term: "bonjour" },
            { id: "v2", term: "salut" },
          ]}
        />,
      ),
    );
    const good = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "progress.grade.good",
    )!;
    await act(async () => good.click());
    expect(gradeVocabulary).toHaveBeenCalledWith("v1", "good");
    expect(container.textContent).toContain("salut");
    expect(container.textContent).not.toContain("bonjour");
  });
});
