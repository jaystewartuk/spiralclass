// @vitest-environment jsdom
//
// AddMaterialFlow — the method-picker entry step + one of three sub-flows +
// success panel (UX redesign), extracted from AddMaterialSheet so it's
// testable without the Radix Sheet/Dialog chrome. Covers: routing from the
// chooser into a mode, Back returning to the chooser, and the success panel
// replacing the form after a save (View material / Assign to a student /
// Create another, the last of which returns to the chooser).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

const saveMaterialContentAction = vi.fn();

vi.mock("@/app/actions/library", () => ({
  refineMaterialDraftAction: vi.fn(),
  saveMaterialContentAction: (...args: unknown[]) => saveMaterialContentAction(...args),
}));
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "es-MX",
}));

const { AddMaterialFlow } = await import("@/app/(app)/dashboard/materials/add-material-sheet");

const levels = [{ id: "l1", label: "A1" }];

describe("AddMaterialFlow — routing", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    saveMaterialContentAction.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderFlow(onViewMaterial = vi.fn()) {
    act(() => {
      root.render(
        React.createElement(AddMaterialFlow, {
          levels,
          focusGroups: [],
          templates: [],
          aiEnabled: true,
          isPro: true,
          onViewMaterial,
        }),
      );
    });
    return onViewMaterial;
  }

  function clickByText(text: string) {
    const el = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text),
    );
    if (!el) throw new Error(`button with text "${text}" not found`);
    act(() => el.click());
  }

  it("shows the method picker by default", () => {
    renderFlow();
    expect(container.textContent).toContain("web.materials.method.title");
  });

  it("routes into the manual sub-flow and Back returns to the chooser", () => {
    renderFlow();
    clickByText("web.materials.method.manualTitle");
    // The manual flow's own body-editor label proves we left the chooser.
    expect(container.textContent).toContain("web.dashboard.classes.classContent.contentMarkdown");
    expect(container.textContent).not.toContain("web.materials.method.title");

    clickByText("common.back");
    expect(container.textContent).toContain("web.materials.method.title");
  });

  it("routes into the upload sub-flow", () => {
    renderFlow();
    clickByText("web.materials.method.uploadTitle");
    expect(container.textContent).toContain("web.materials.file");
    expect(container.textContent).toContain("materials.link");
  });

  it("shows the success panel after a save, then Create another returns to the chooser", async () => {
    saveMaterialContentAction.mockResolvedValue({ ok: true, materialId: "m1" });
    const onViewMaterial = renderFlow();

    clickByText("web.materials.method.manualTitle");
    const body = container.querySelector<HTMLTextAreaElement>("#manual-body");
    expect(body).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(body!, "# Hello\n\nSome content");
      body!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const form = container.querySelector("form");
    expect(form).toBeTruthy();
    await act(async () => {
      form!.requestSubmit();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("web.materials.success.title");
    expect(container.textContent).toContain("web.materials.success.viewMaterial");
    expect(container.textContent).toContain("web.materials.success.assign");
    expect(container.textContent).toContain("web.materials.success.createAnother");

    clickByText("web.materials.success.viewMaterial");
    expect(onViewMaterial).toHaveBeenCalledTimes(1);

    clickByText("web.materials.success.createAnother");
    expect(container.textContent).toContain("web.materials.method.title");
  });
});
