// @vitest-environment jsdom
//
// grandfathering, per package, on the signed-in repurchase screen.
//
// What this pins is that the DISPLAY agrees with the charge. The flat column
// this replaced was applied to every row of the list, so a student held at an
// old 4-class price saw the 20-class package at that price, labelled "your
// agreed price" — and `startCheckout` then charged it. Display and charge were
// wrong together, which is why nothing caught it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("@/app/actions/checkout", () => ({
  createPortalCheckoutIntent: vi.fn(),
}));

vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn() }));
vi.mock("@stripe/react-stripe-js", () => ({
  EmbeddedCheckoutProvider: () => null,
  EmbeddedCheckout: () => null,
}));

const { PortalPurchaseFlow } = await import("@/app/(student)/my-classes/buy/portal-purchase-flow");

// Alicia Moreno's real ladder after the 2026-08-31 repricing.
const FOUR = {
  id: "tpl-4",
  name: "4 classes / 2 months",
  classCount: 4,
  classDurationMin: 50,
  priceMinorUnits: 185_000,
  transferPriceMinorUnits: null,
  expirationMonths: 2,
};
const TWENTY = {
  id: "tpl-20",
  name: "20 classes / 7 months",
  classCount: 20,
  classDurationMin: 50,
  priceMinorUnits: 800_000,
  transferPriceMinorUnits: null,
  expirationMonths: 7,
};

describe("PortalPurchaseFlow — per-package grandfathered prices", () => {
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

  function render(agreedPrices: Record<string, number>) {
    act(() => {
      root.render(
        React.createElement(PortalPurchaseFlow, {
          teacherId: "t1",
          templates: [FOUR, TWENTY],
          agreedPrices,
          stripeReady: true,
          instruments: [],
        }),
      );
    });
  }

  const shown = () => container.textContent ?? "";

  it("shows catalog prices for a student with no agreed price", () => {
    render({});
    expect(shown()).toContain("1,850.00");
    expect(shown()).toContain("8,000.00");
    expect(shown()).not.toContain("web.studentBuy.yourAgreedPrice");
  });

  // The regression. Grandfathered on the 4-class package only.
  it("holds ONLY the agreed package at its old price, and marks just that one", () => {
    render({ [FOUR.id]: 130_000 });
    // Her old 4-class price.
    expect(shown()).toContain("1,300.00");
    // The 20-class package stays at catalog — it was never agreed.
    expect(shown()).toContain("8,000.00");
    // ...and the agreed price appears once, not on every row.
    expect(shown().match(/1,300\.00/g)).toHaveLength(1);
    // Exactly one row carries the "your agreed price" label.
    expect(shown().match(/web\.studentBuy\.yourAgreedPrice/g)).toHaveLength(1);
  });

  it("marks every row when every package was agreed", () => {
    render({ [FOUR.id]: 130_000, [TWENTY.id]: 600_000 });
    expect(shown()).toContain("1,300.00");
    expect(shown()).toContain("6,000.00");
    expect(shown().match(/web\.studentBuy\.yourAgreedPrice/g)).toHaveLength(2);
  });

  // The hidden `templateId` is what the server prices against, so picking a
  // package the student has no agreed price for must submit THAT template —
  // the server then resolves its own price and finds no agreed one.
  it("submits the selected package's template id", () => {
    render({ [FOUR.id]: 130_000 });
    const submitted = () =>
      container.querySelector<HTMLInputElement>('input[name="templateId"]')?.value;
    expect(submitted()).toBe(FOUR.id);

    const twenty = container.querySelector<HTMLInputElement>(
      `input[type="radio"][value="${TWENTY.id}"]`,
    );
    expect(twenty).not.toBeNull();
    act(() => {
      twenty!.click();
    });
    expect(submitted()).toBe(TWENTY.id);
  });
});
