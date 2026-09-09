// @vitest-environment jsdom
//
// The library row's permanent delete, and the confirmation in front of it.
//
// `deleteLibraryMaterialAction` removes the storage object, sweeps the embedded
// images and drops the row with its student assignments. There is no undo. It
// used to be a bare submit button sitting at the same visual weight as Archive
// in a footer of five, one click from a row the teacher had merely moused over
// — so what these tests actually guard is that a click on "Delete" submits
// nothing at all until a second, differently-worded confirmation is given.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const deleteLibraryMaterialAction = vi.fn();

vi.mock("@/app/actions/library", () => ({
  deleteLibraryMaterialAction: (...args: unknown[]) => deleteLibraryMaterialAction(...args),
}));
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
  useLocale: () => "en",
}));

const { DeleteMaterialButton } =
  await import("@/app/(app)/dashboard/materials/delete-material-button");

function byText(text: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>("button, [role='alertdialog'] *")].find(
    (el) => el.textContent?.trim() === text,
  );
}

describe("DeleteMaterialButton", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    deleteLibraryMaterialAction.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(DeleteMaterialButton, {
          materialId: "mat-1",
          name: "Past simple worksheet",
        }),
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows only a trigger — no delete form is mounted until it is opened", () => {
    expect(document.querySelector("form")).toBeNull();
    expect(document.querySelector("[role='alertdialog']")).toBeNull();
  });

  it("names the material in the trigger's accessible label, not just 'Delete'", () => {
    // A footer of five buttons cannot repeat the title on screen, but a screen
    // reader's element list is one "Delete" per row without this.
    const trigger = container.querySelector("button");
    expect(trigger?.getAttribute("aria-label")).toBe(
      "web.materials.deleteNamed:Past simple worksheet",
    );
  });

  it("opens an alertdialog rather than submitting, and only then mounts the form", () => {
    act(() => {
      container.querySelector("button")!.click();
    });
    expect(deleteLibraryMaterialAction).not.toHaveBeenCalled();

    const dialog = document.querySelector("[role='alertdialog']");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("web.materials.deleteTitle");
    // The warning that says what "permanently" costs.
    expect(dialog!.textContent).toContain("web.materials.deleteBody");
  });

  it("carries the material id, and only that, into the confirmed submit", () => {
    act(() => {
      container.querySelector("button")!.click();
    });
    const form = document.querySelector<HTMLFormElement>("[role='alertdialog'] form");
    expect(form).not.toBeNull();
    const inputs = [...form!.querySelectorAll<HTMLInputElement>("input")];
    expect(inputs.map((i) => [i.name, i.value])).toEqual([["materialId", "mat-1"]]);
  });

  it("labels the confirm button as permanent, and keeps a way out", () => {
    act(() => {
      container.querySelector("button")!.click();
    });
    // The confirm says what it does; "Delete" alone was the whole problem.
    expect(byText("web.materials.deleteConfirm")).toBeDefined();
    expect(byText("common.cancel")).toBeDefined();
  });

  it("closes on cancel without ever calling the action", () => {
    act(() => {
      container.querySelector("button")!.click();
    });
    act(() => {
      byText("common.cancel")!.click();
    });
    expect(document.querySelector("[role='alertdialog']")).toBeNull();
    expect(deleteLibraryMaterialAction).not.toHaveBeenCalled();
  });
});
