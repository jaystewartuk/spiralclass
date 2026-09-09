// @vitest-environment jsdom
//
// The buy page's ORDER is the change, so the order is what these pin. Three
// things had gone wrong and none of them is visible in a type signature:
//
//   * the payment-rail switcher was the first control on the page, ahead of
//     the price it applies to;
//   * the package list was re-asked after the landing page had already
//     collected the answer via `?package=` (`package_selected` never fired
//     once in production);
//   * a single class put its REQUIRED slot picker after the pay button, so the
//     button sat disabled above the only control that could enable it.
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
vi.mock("@/app/actions/checkout", () => ({ createCheckoutIntent: vi.fn() }));
vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn() }));
vi.mock("@stripe/react-stripe-js", () => ({
  EmbeddedCheckoutProvider: () => null,
  EmbeddedCheckout: () => null,
}));
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) =>
    React.createElement("img", { alt: String(props.alt ?? ""), src: String(props.src ?? "") }),
}));
// The slot grid does real date math against availability rules; this suite is
// about placement, so stand in for it with something findable.
vi.mock("@/app/b/[slug]/buy/class-slot-picker", () => ({
  ClassSlotPicker: () => React.createElement("div", { "data-testid": "slot-picker" }),
}));

const { PurchaseFlow } = await import("@/app/b/[slug]/buy/purchase-flow");

const PACKAGE = {
  id: "tpl-4",
  name: "4 classes",
  classCount: 4,
  singleClass: false,
  classDurationMin: 50,
  priceMinorUnits: 130_000,
  transferPriceMinorUnits: 120_000,
  expirationMonths: 2,
  currency: "MXN",
  approxUsdCents: null,
};

const SINGLE = {
  ...PACKAGE,
  id: "tpl-1",
  name: "Individual class",
  classCount: 1,
  singleClass: true,
  priceMinorUnits: 38_000,
  transferPriceMinorUnits: 38_000,
  expirationMonths: 1,
};

const WISE = {
  id: "inst-wise",
  kind: "wise" as const,
  enabled: true,
  accountHolder: "Mira",
  wiseHandle: "mira",
  wiseEmail: null,
  schemeId: null,
  details: null,
};

describe("PurchaseFlow — order of the buy page", () => {
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

  function render(over: Record<string, unknown> = {}) {
    act(() => {
      root.render(
        React.createElement(PurchaseFlow, {
          slug: "alicia-moreno",
          teacherName: "Alicia Moreno",
          teacherPhotoUrl: "https://cdn.test/mira.jpg",
          testimonial: null,
          templates: [PACKAGE, SINGLE],
          initialTemplateId: PACKAGE.id,
          stripeReady: true,
          instruments: [WISE],
          slotTeacher: {
            timezone: "America/Mexico_City",
            bufferMin: 0,
            minAdvanceH: 2,
            maxAdvanceDays: 30,
          },
          slotInputs: { availabilityRules: [], blockedDates: [], existingBookings: [] },
          ...over,
        } as never),
      );
    });
  }

  // Position of a node in document order, for "X comes before Y" assertions.
  function indexOf(selector: string): number {
    const all = Array.from(container.querySelectorAll("*"));
    const el = container.querySelector(selector);
    expect(el, `expected to find ${selector}`).not.toBeNull();
    return all.indexOf(el!);
  }

  it("shows the chosen package as a summary, not a re-ask", () => {
    render();
    // No radio group until the buyer asks to change it.
    expect(container.querySelectorAll('input[name="package"]').length).toBe(0);
    expect(container.textContent).toContain("4 classes");
  });

  it("reopens the full list when the buyer asks to change", () => {
    render();
    const change = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("web.buyFlow.changePackage"),
    );
    expect(change).toBeDefined();
    act(() => change!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelectorAll('input[name="package"]').length).toBe(2);
  });

  it("puts the rail switcher behind a disclosure, after the pay button", () => {
    render();
    const details = container.querySelector("details");
    expect(details, "the rail switcher should be a disclosure").not.toBeNull();
    expect(details!.open).toBe(false);
    expect(indexOf("form")).toBeLessThan(indexOf("details"));
  });

  it("keeps the rail switcher in the open when there is no card rail to default to", () => {
    // Two transfer instruments and no Stripe: these are the only ways to pay,
    // so hiding them behind a summary would hide the checkout itself.
    render({
      stripeReady: false,
      instruments: [WISE, { ...WISE, id: "inst-spei", kind: "bank_account", schemeId: "mx_clabe" }],
    });
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelectorAll('input[name="method-toggle"]').length).toBe(2);
  });

  it("puts a single class's REQUIRED slot picker before the pay button", () => {
    render({ templates: [SINGLE], initialTemplateId: SINGLE.id });
    expect(indexOf('[data-testid="slot-picker"]')).toBeLessThan(indexOf("form"));
  });

  it("puts a package's OPTIONAL first-class picker after it", () => {
    render();
    expect(indexOf("form")).toBeLessThan(indexOf('[data-testid="slot-picker"]'));
  });

  it("carries the teacher's face and a quote into the checkout", () => {
    render({
      testimonial: { body: "She is wonderful", authorName: "Fixture", authorNote: "A2 · 3 months" },
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn.test/mira.jpg");
    expect(container.textContent).toContain("She is wonderful");
    expect(container.textContent).toContain("Fixture");
  });

  it("renders the approximate second price only when the server supplied one", () => {
    render();
    expect(container.textContent).not.toContain("web.buyFlow.approxPrice");

    act(() => root.unmount());
    root = createRoot(container);
    render({
      templates: [{ ...PACKAGE, approxUsdCents: 7_500 }, SINGLE],
      initialTemplateId: PACKAGE.id,
    });
    expect(container.textContent).toContain("web.buyFlow.approxPrice");
  });

  it("shows it in the expanded list too, not only in the collapsed summary", () => {
    // A teacher selling exactly one package never gets the collapsed summary —
    // there is nothing to change — so the figure has to live on the row as
    // well, or her buyers are the only ones who never see it.
    render({
      templates: [{ ...SINGLE, approxUsdCents: 2_200 }],
      initialTemplateId: SINGLE.id,
    });
    expect(container.textContent).toContain("web.buyFlow.approxPrice");
  });
});
