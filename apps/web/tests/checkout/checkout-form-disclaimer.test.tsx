// @vitest-environment jsdom
//
// From the 2026-08-05 product review: the seller-of-record (CFDI) disclaimer in
// CheckoutForm must be rail-aware. The Stripe copy ("SpiralClass processes
// the charge on behalf of the teacher") is factually wrong for Wise, where
// the transfer goes direct to the teacher and the platform never touches
// the payment — but both variants must keep the seller-of-record sentence,
// since it's a legal/tax (CFDI) statement, not just a payment-rail one.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("posthog-js/react", () => ({ usePostHog: () => ({ capture: vi.fn() }) }));

vi.mock("@/app/actions/checkout", () => ({
  createCheckoutIntent: vi.fn(),
}));

vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn() }));
vi.mock("@stripe/react-stripe-js", () => ({
  EmbeddedCheckoutProvider: () => null,
  EmbeddedCheckout: () => null,
}));

const { CheckoutForm } = await import("@/app/b/[slug]/buy/checkout-form");

describe("CheckoutForm — seller disclaimer", () => {
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

  function render(method: "stripe" | "manual_transfer") {
    act(() => {
      root.render(
        React.createElement(CheckoutForm, {
          slug: "maria",
          templateId: "tpl-1",
          priceMinorUnits: 100_000,
          transferPriceMinorUnits: 90_000,
          currency: "MXN",
          method,
          // Since D-113 the form also forwards WHICH instrument was picked.
          instrumentId: method === "manual_transfer" ? "inst-wise-1" : null,
          instrumentKind: method === "manual_transfer" ? ("wise" as const) : null,
          noMethods: false,
        }),
      );
    });
  }

  it("shows the Stripe disclaimer when Stripe is selected", () => {
    render("stripe");
    expect(container.textContent).toContain("buy.sellerDisclaimer.stripe");
    expect(container.textContent).not.toContain("buy.sellerDisclaimer.wise");
  });

  it("shows the transfer disclaimer, keeping the seller-of-record (CFDI) sentence", () => {
    render("manual_transfer");
    expect(container.textContent).toContain("buy.sellerDisclaimer.wise");
    expect(container.textContent).not.toContain("buy.sellerDisclaimer.stripe");
  });
});
