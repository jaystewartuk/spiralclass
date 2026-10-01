// @vitest-environment jsdom
//
// The in-call notes card. Open, it covered the top of a shared material on a
// teacher's phone with no way to put it away; it now collapses to its title,
// says how many notes it holds while closed, and remembers the choice on this
// browser — without breaking when storage is unavailable.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { CallNotesCard } = await import("@/components/video/call-notes-card");

const KEY = "test.callNotes";
let container: HTMLDivElement;
let root: Root;

function render() {
  act(() =>
    root.render(
      <CallNotesCard title="My cues" count={4} storageKey={KEY}>
        <ul>
          <li>Ser y estar</li>
        </ul>
      </CallNotesCard>,
    ),
  );
}

const toggle = () => container.querySelector("button")!;
const body = () => container.querySelector("ul")!.parentElement!;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("CallNotesCard", () => {
  it("starts open, showing the notes", () => {
    render();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(body().hidden).toBe(false);
    expect(toggle().textContent).not.toContain("(4)");
  });

  it("collapses to its title and count, and remembers it", () => {
    render();
    act(() => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(body().hidden).toBe(true);
    expect(toggle().textContent).toContain("My cues");
    expect(toggle().textContent).toContain("(4)");
    expect(window.localStorage.getItem(KEY)).toBe("collapsed");
  });

  it("re-opens and forgets the collapse", () => {
    render();
    act(() => toggle().click());
    act(() => toggle().click());
    expect(body().hidden).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("starts collapsed when this browser last left it collapsed", () => {
    window.localStorage.setItem(KEY, "collapsed");
    render();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("still toggles when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render();
    expect(body().hidden).toBe(false);
    act(() => toggle().click());
    expect(body().hidden).toBe(true);
  });
});
