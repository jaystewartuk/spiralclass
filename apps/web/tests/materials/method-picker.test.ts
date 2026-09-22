// @vitest-environment jsdom
//
// MethodPicker — the "Add material" entry step (UX redesign). Three cards
// (AI / manual / upload), each routing to a focused sub-flow via onSelect.
// The AI card is omitted entirely when the platform has no AI credentials
// (aiEnabled), and shows an inline Pro upsell — never hidden — when the
// teacher isn't Pro.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
}));

const { MethodPicker } = await import("@/components/materials/method-picker");

describe("MethodPicker", () => {
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

  function renderPicker(overrides: { aiEnabled?: boolean; isPro?: boolean } = {}) {
    const onSelect = vi.fn();
    act(() => {
      root.render(
        React.createElement(MethodPicker, {
          aiEnabled: true,
          isPro: true,
          onSelect,
          ...overrides,
        }),
      );
    });
    return onSelect;
  }

  it("renders all three method cards when AI is enabled", () => {
    renderPicker();
    expect(container.textContent).toContain("web.materials.method.aiTitle");
    expect(container.textContent).toContain("web.materials.method.manualTitle");
    expect(container.textContent).toContain("web.materials.method.uploadTitle");
  });

  it("omits the AI card entirely when the platform has no AI credentials", () => {
    renderPicker({ aiEnabled: false });
    expect(container.textContent).not.toContain("web.materials.method.aiTitle");
    expect(container.textContent).toContain("web.materials.method.manualTitle");
    expect(container.textContent).toContain("web.materials.method.uploadTitle");
  });

  it("shows an inline Pro upsell on the AI card for a Free teacher, without hiding it", () => {
    renderPicker({ isPro: false });
    expect(container.textContent).toContain("web.materials.method.aiTitle");
    expect(container.textContent).toContain("classContent.author.proRequired");
  });

  it("does not show the Pro upsell for a Pro teacher", () => {
    renderPicker({ isPro: true });
    expect(container.textContent).not.toContain("classContent.author.proRequired");
  });

  it("routes to the matching mode when each card is clicked", () => {
    const onSelect = renderPicker();
    const buttons = Array.from(container.querySelectorAll("button"));
    const aiButton = buttons.find((b) => b.textContent?.includes("web.materials.method.aiTitle"));
    const manualButton = buttons.find((b) =>
      b.textContent?.includes("web.materials.method.manualTitle"),
    );
    const uploadButton = buttons.find((b) =>
      b.textContent?.includes("web.materials.method.uploadTitle"),
    );
    expect(aiButton).toBeTruthy();
    expect(manualButton).toBeTruthy();
    expect(uploadButton).toBeTruthy();

    act(() => aiButton!.click());
    expect(onSelect).toHaveBeenLastCalledWith("ai");
    act(() => manualButton!.click());
    expect(onSelect).toHaveBeenLastCalledWith("manual");
    act(() => uploadButton!.click());
    expect(onSelect).toHaveBeenLastCalledWith("upload");
  });
});
