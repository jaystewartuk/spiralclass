// @vitest-environment jsdom
//
// The teacher's in-call quick note. It has to be one line and one key to save,
// it must not leak a keystroke to the call's single-key shortcuts (typing "m"
// must not mute her), and a refusal (non-Pro, not found) has to be said rather
// than swallowed.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

const { CallQuickNote } = await import("@/components/video/call-quick-note");

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
});

type Submit = (input: unknown) => Promise<{ ok?: boolean; error?: string }>;

function render(onSubmit: Submit = vi.fn(async () => ({ ok: true })), open = true) {
  act(() => root.render(<CallQuickNote open={open} onClose={vi.fn()} onSubmit={onSubmit} />));
  return onSubmit;
}

function field() {
  return container.querySelector<HTMLTextAreaElement>("[data-testid=call-quick-note-input]")!;
}

function type(value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CallQuickNote", () => {
  it("renders nothing while closed", () => {
    render(undefined, false);
    expect(container.querySelector("[data-testid=call-quick-note-sheet]")).toBeNull();
  });

  it("saves with the default category on Enter, then empties the field", async () => {
    const onSubmit = render();
    type("  practise the subjunctive ");
    await act(async () => {
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith({
      category: "grammar",
      summary: "practise the subjunctive",
    });
    expect(field().value).toBe("");
  });

  it("does not save on Shift+Enter or an empty note", async () => {
    const onSubmit = render();
    await act(async () => {
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    type("x");
    await act(async () => {
      field().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
      );
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the note and shows the refusal when the action says no", async () => {
    render(vi.fn(async () => ({ error: "upgrade to Pro" })));
    type("food words");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid=call-quick-note-save]")!.click();
    });
    expect(container.textContent).toContain("upgrade to Pro");
    expect(field().value).toBe("food words");
  });
});
