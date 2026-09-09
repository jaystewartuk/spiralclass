// @vitest-environment jsdom
//
// The signed-in repurchase flow must be able to submit a discount code.
// `createPortalCheckoutIntent` has always parsed `discountCode` off this
// form, but no input ever rendered it — so a student who was sent a code
// could not spend it without leaving for the public /b/[slug] funnel. The
// referrer's own reward is the sharpest case: the "your referral earned you
// a reward" email prints the code and links to /my-classes, which is this
// flow. These tests pin the field's presence, its wire name, and the
// collapsed-by-default behaviour that keeps an empty box off the page for
// the majority who have no code.
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

const TEMPLATES = [
  {
    id: "tpl-1",
    name: "Paquete 4 clases",
    classCount: 4,
    classDurationMin: 60,
    priceMinorUnits: 100_000,
    transferPriceMinorUnits: 90_000,
    expirationMonths: null,
  },
];

describe("PortalPurchaseFlow — discount code", () => {
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
        React.createElement(PortalPurchaseFlow, {
          teacherId: "t1",
          templates: TEMPLATES,
          agreedPrices: {},
          stripeReady: true,
          instruments: [],
        }),
      );
    });
  }

  function discountInput(): HTMLInputElement | null {
    return container.querySelector('input[name="discountCode"]');
  }

  it("keeps the field collapsed until the student asks for it", () => {
    render();
    expect(discountInput()).toBeNull();
    expect(container.textContent).toContain("web.checkoutForm.haveDiscountCode");
  });

  it("reveals an input named discountCode, which is what the server action reads", () => {
    render();
    const toggle = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("web.checkoutForm.haveDiscountCode"),
    );
    expect(toggle).toBeDefined();
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const input = discountInput();
    expect(input).not.toBeNull();
    // The name is the contract with portalCheckoutIntentSchema — a rename
    // here silently stops codes applying, with no error anywhere.
    expect(input!.name).toBe("discountCode");
    // It has to be inside the form that submits to the action, or the value
    // never reaches the server.
    expect(input!.closest("form")).not.toBeNull();
  });
});
