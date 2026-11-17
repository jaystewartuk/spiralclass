// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createT } from "@spiralclass/shared";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/locale-provider", () => ({
  useT: () => createT("en"),
  useLocale: () => "en",
}));
vi.mock("@/components/pricing-currency-context", () => ({ usePricingCurrency: () => "GBP" }));
vi.mock("@/app/actions/teacher-packages", () => ({
  createManualPackageAction: vi.fn(),
  deleteManualPackageAction: vi.fn(),
}));
vi.mock("@/app/(app)/dashboard/students/[studentId]/for-two-field", () => ({
  ForTwoField: () => null,
}));

const { AddPackageForm } =
  await import("@/app/(app)/dashboard/students/[studentId]/add-package-form");
const { DeletePackageButton } =
  await import("@/app/(app)/dashboard/students/[studentId]/delete-package-button");

describe("manual package controls", () => {
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

  function input(name: string) {
    return container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  }
  function fill(name: string, value: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input(name),
        value,
      );
      input(name).dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function openForm() {
    act(() =>
      root.render(
        <AddPackageForm
          studentId="student-1"
          templates={[
            {
              id: "template-1",
              name: "Ten classes",
              classCount: 10,
              classDurationMin: 50,
              pricePesos: "100",
            },
          ]}
        />,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>("button")!.click());
  }

  it("defaults a new custom package to its full balance while the total is typed", () => {
    openForm();
    fill("classesTotal", "1");
    expect(input("classesRemaining").value).toBe("1");
    fill("classesTotal", "10");
    expect(input("classesRemaining").value).toBe("10");
    expect(new FormData(container.querySelector("form")!).get("classesRemaining")).toBe("10");
  });

  it.each(["4", "0"])("preserves an explicitly entered remaining balance of %s", (remaining) => {
    openForm();
    fill("classesTotal", "10");
    fill("classesRemaining", remaining);
    fill("classesTotal", "12");
    expect(input("classesRemaining").value).toBe(remaining);
  });

  it("starts fresh with the full template balance when a template is selected", () => {
    openForm();
    fill("classesTotal", "5");
    fill("classesRemaining", "0");
    act(() => {
      const select = container.querySelector("select")!;
      select.value = "template-1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(input("classesRemaining").value).toBe("10");
    fill("classesTotal", "12");
    expect(input("classesRemaining").value).toBe("12");
  });

  it("keeps a cleared balance invalid instead of silently turning it into zero", () => {
    openForm();
    fill("classesTotal", "10");
    fill("classesRemaining", "");
    const event = new Event("submit", { bubbles: true, cancelable: true });
    act(() => container.querySelector("form")!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(input("classesRemaining").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input("classesRemaining"));
  });

  it.each(["hasBookings", "hasPayment"] as const)(
    "explains why Delete is unavailable: %s",
    (key) => {
      const reason = createT("en")(`web.action.teacherPackages.${key}`);
      act(() => root.render(<DeletePackageButton packageId="package-1" blockedReason={reason} />));
      const button = container.querySelector("button")!;
      expect(button.textContent).toBe("Delete");
      expect(button.disabled).toBe(true);
      expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe(
        reason,
      );
    },
  );

  it("offers confirmation before deleting an unused package", () => {
    act(() => root.render(<DeletePackageButton packageId="package-1" />));
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(false);
    act(() => button.click());
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Delete this package?",
    );
    expect(document.querySelector<HTMLInputElement>('input[name="packageId"]')?.value).toBe(
      "package-1",
    );
  });
});
