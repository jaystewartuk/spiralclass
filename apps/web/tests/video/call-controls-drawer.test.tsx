// @vitest-environment jsdom
//
// CallControlsDrawer — the web call's control-row drawer handle, mirroring
// mobile's `controlsCollapsed` (NativeCall.tsx). These pin the three things a
// refactor could quietly undo:
//
//   1. The handle is ALWAYS mounted. Collapsing hides the whole row — Leave
//      included — so the handle is the only route back; if it ever became
//      conditional on `!collapsed`, a user would strand themselves in a call
//      with no controls at all.
//   2. Collapsing actually removes the row from layout AND from the
//      accessibility tree, rather than just fading it — a `hidden`-less
//      "collapse" that only dims the row would still eat the strip of screen
//      it was collapsed to free up, and would still be tabbable.
//   3. The label/`aria-expanded` pair flips with the state. The control is an
//      unlabelled chevron, so the accessible name is the ONLY thing that says
//      which way the drawer points.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

const { CallControlsDrawer } = await import("@/components/video/call-controls-drawer");

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

function render() {
  act(() => {
    root.render(
      <CallControlsDrawer>
        <button type="button">leave</button>
      </CallControlsDrawer>,
    );
  });
}

const handle = () => container.querySelector("button[aria-expanded]") as HTMLButtonElement;
// `getElementById`, not a `#id` selector: useId() ids are `:r0:`-shaped and the
// colons need escaping the jsdom build here has no `CSS.escape` for.
const rowEl = () => document.getElementById(handle().getAttribute("aria-controls")!)!;

describe("CallControlsDrawer", () => {
  it("starts expanded — nothing hides itself until asked", () => {
    render();
    expect(handle().getAttribute("aria-expanded")).toBe("true");
    expect(handle().getAttribute("aria-label")).toBe("call.hideControls");
    expect(rowEl().hidden).toBe(false);
  });

  it("hides the whole control row when the handle is tapped", () => {
    render();
    act(() => handle().click());
    expect(rowEl().hidden).toBe(true);
    // Leave goes with it — the same trade mobile made (NativeCall.tsx):
    // hanging up costs two taps, the material gets the space back.
    expect(rowEl().textContent).toContain("leave");
    expect(rowEl().hidden).toBe(true);
  });

  it("keeps the handle mounted while collapsed — the only route back", () => {
    render();
    act(() => handle().click());
    expect(handle()).toBeTruthy();
    expect(handle().getAttribute("aria-expanded")).toBe("false");
    expect(handle().getAttribute("aria-label")).toBe("call.showControls");
  });

  it("brings the row back on a second tap", () => {
    render();
    act(() => handle().click());
    act(() => handle().click());
    expect(rowEl().hidden).toBe(false);
    expect(handle().getAttribute("aria-expanded")).toBe("true");
  });

  it("does not remount its children across a collapse", () => {
    // The teacher's materials panel lives inside this row and holds open-sheet
    // state; unmounting it on collapse (which is what mobile does) would drop
    // that. Identity of the DOM node is the observable proxy for "same React
    // element instance, never remounted".
    render();
    const before = rowEl().firstElementChild;
    act(() => handle().click());
    act(() => handle().click());
    expect(rowEl().firstElementChild).toBe(before);
  });
});
