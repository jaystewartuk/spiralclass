// @vitest-environment jsdom
//
// The learning-notes sign in the call: a notice each time notes start (never
// on every re-render or on a minimise-and-restore), and a small icon that
// opens what is kept and what is not.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string) => key;
vi.mock("@/components/locale-provider", () => ({
  useT: () => t,
  useLocale: () => "en",
}));

const toast = vi.fn();
vi.mock("sonner", () => ({ toast }));

const { LearningNotesIndicator, useLearningNotesNotice } =
  await import("@/components/video/learning-notes-indicator");

function Notice({ active }: { active: boolean }) {
  useLearningNotesNotice(active);
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  toast.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (node: React.ReactNode) => act(() => root.render(node));

describe("useLearningNotesNotice", () => {
  it("says nothing while notes are off", () => {
    render(<Notice active={false} />);
    expect(toast).not.toHaveBeenCalled();
  });

  it("announces once when notes start, not on every render", () => {
    render(<Notice active={false} />);
    render(<Notice active />);
    render(<Notice active />);
    expect(toast).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith("call.notesStartedTitle", {
      description: "call.notesExplain",
      duration: 8000,
    });
  });

  it("announces again when notes stop and start again", () => {
    render(<Notice active />);
    render(<Notice active={false} />);
    render(<Notice active />);
    expect(toast).toHaveBeenCalledTimes(2);
  });
});

describe("LearningNotesIndicator", () => {
  const icon = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="learning-notes-indicator"]')!;

  it("is a labelled icon, closed until tapped", () => {
    render(<LearningNotesIndicator />);
    expect(icon().getAttribute("aria-label")).toBe("call.notesOn");
    expect(icon().getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("tapped, says what is kept and links to the privacy notice", () => {
    render(<LearningNotesIndicator />);
    act(() => icon().click());
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("call.notesExplain");
    expect(dialog.querySelector("a")?.getAttribute("href")).toBe("/privacy-notice");
    expect(icon().getAttribute("aria-expanded")).toBe("true");
  });

  it("closes on Escape and on a tap outside it", () => {
    render(<LearningNotesIndicator />);
    act(() => icon().click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    act(() => icon().click());
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
