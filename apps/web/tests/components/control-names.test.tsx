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

  it("names a vocabulary card by its displayed term and its action", () => {
    act(() =>
      root.render(
        <VocabReview terms={[{ id: "v1", term: "bonjour", context: "Bonjour, tout le monde." }]} />,
      ),
    );
    const name = controlName(container.querySelector("button")!);
    expect(name).toContain("bonjour");
    expect(name).toContain("progress.flashcard.flip");
  });

  it("names the revealed context as well as the action to show the term again", () => {
    act(() =>
      root.render(
        <VocabReview terms={[{ id: "v1", term: "bonjour", context: "Bonjour, tout le monde." }]} />,
      ),
    );
    act(() => container.querySelector("button")!.click());
    const name = controlName(container.querySelector("button")!);
    expect(name).toContain("Bonjour, tout le monde.");
    expect(name).toContain("progress.flashcard.showTerm");
  });

  it("names the empty-context fallback on a revealed card", () => {
    act(() => root.render(<VocabReview terms={[{ id: "v1", term: "bonjour", context: null }]} />));
    act(() => container.querySelector("button")!.click());
    expect(controlName(container.querySelector("button")!)).toContain(
      "progress.flashcard.noContext",
    );
  });

  it("grades the current term and returns the next card to its front", async () => {
    act(() =>
      root.render(
        <VocabReview
          terms={[
            { id: "v1", term: "bonjour", context: "Bonjour, tout le monde." },
            { id: "v2", term: "salut", context: null },
          ]}
        />,
      ),
    );
    act(() => container.querySelector("button")!.click());
    const good = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "progress.grade.good",
    )!;
    await act(async () => good.click());
    expect(gradeVocabulary).toHaveBeenCalledWith("v1", "good");
    const name = controlName(container.querySelector("button")!);
    expect(name).toContain("salut");
    expect(name).toContain("progress.flashcard.flip");
  });
});
