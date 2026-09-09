// @vitest-environment jsdom
//
// From the 2026-08-05 product review: same rail-aware seller disclaimer fix as
// checkout-form-disclaimer.test.tsx, for the signed-in in-portal repurchase
// flow. See that file for the full rationale.
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

describe("PortalPurchaseFlow — seller disclaimer", () => {
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

  // D-113: the flow takes the offerable instruments, not a `wiseReady` flag.
  const WISE_INSTRUMENT = {
    id: "inst-wise-1",
    kind: "wise" as const,
    enabled: true,
    accountHolder: "Mira",
    wiseHandle: "mira",
    wiseEmail: null,
    schemeId: null,
    country: null,
    details: null,
  };

  function render({
    stripeReady,
    transferReady,
  }: {
    stripeReady: boolean;
    transferReady: boolean;
  }) {
    act(() => {
      root.render(
        React.createElement(PortalPurchaseFlow, {
          teacherId: "t1",
          templates: TEMPLATES,
          agreedPrices: {},
          stripeReady,
          instruments: transferReady ? [WISE_INSTRUMENT] : [],
        }),
      );
    });
  }

  it("shows the Stripe disclaimer for a Stripe-only teacher", () => {
    render({ stripeReady: true, transferReady: false });
    expect(container.textContent).toContain("buyAnother.disclaimer.stripe");
    expect(container.textContent).not.toContain("buyAnother.disclaimer.wise");
  });

  it("shows the transfer disclaimer, keeping the seller-of-record (CFDI) sentence", () => {
    render({ stripeReady: false, transferReady: true });
    expect(container.textContent).toContain("buyAnother.disclaimer.wise");
    expect(container.textContent).not.toContain("buyAnother.disclaimer.stripe");
  });
});
