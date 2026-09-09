// @vitest-environment jsdom
//
// Product review the public booking page: a teacher outside the Stripe Connect payout circle (D-58) never
// gets a Stripe rail at all — Wise is her only rail — so the "Stripe price" /
// "charge less for bank transfer (Wise)" split is meaningless: there's no
// Stripe price to discount against. `payoutCountrySupported` (derived from
// `isConnectCountrySupported(teacher.country)` by both callers) collapses
// the split to a single plain "Price" field and hides the whole
// Wise-discount card for those teachers.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// The row renders a Radix Checkbox (the Wise-discount toggle), whose size hook
// wants a ResizeObserver jsdom doesn't implement. Nothing here measures
// anything, so a no-op stub is enough.
(globalThis as Record<string, unknown>).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
}));
vi.mock("@/app/actions/onboarding", () => ({ saveTemplatesAction: vi.fn() }));

const { TemplatesForm } = await import("@/app/(app)/onboarding/templates/templates-form");

const ROW = {
  id: "tpl-1",
  name: "8 clases / 1 mes",
  subject: "Conversation",
  classCount: 8,
  singleClass: false,
  classDurationMin: 50,
  priceMinorUnits: 240000,
  transferPriceMinorUnits: null,
  expirationMonths: 1,
};

function priceLabelText(container: HTMLElement): string | undefined {
  return container.querySelector<HTMLLabelElement>('label[for^="price-"]')?.textContent;
}

function wiseDiscountCheckbox(container: HTMLElement): Element | null {
  return container.querySelector('button[id^="wise-discount-"]');
}

describe("TemplatesForm — payout-country gating (the public booking page)", () => {
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
    vi.clearAllMocks();
  });

  it("shows the Stripe price label and the Wise-discount card for a supported country", () => {
    act(() =>
      root.render(
        React.createElement(TemplatesForm, { initial: [ROW], payoutCountrySupported: true }),
      ),
    );
    expect(priceLabelText(container)).toBe("onboarding.templates.priceStripe");
    expect(wiseDiscountCheckbox(container)).not.toBeNull();
  });

  it("shows a single plain Price label and hides the Wise-discount card for an unsupported country", () => {
    act(() =>
      root.render(
        React.createElement(TemplatesForm, { initial: [ROW], payoutCountrySupported: false }),
      ),
    );
    expect(priceLabelText(container)).toBe("onboarding.templates.price");
    expect(wiseDiscountCheckbox(container)).toBeNull();
  });

  it("CLEARS a stale Wise price for an unsupported country, rather than resubmitting it", () => {
    // This test used to assert only that the card was hidden, and its comment
    // said the stored value was deliberately left alone. That was the bug.
    //
    // Checkout charges `transferPriceMinorUnits ?? priceMinorUnits`
    // (lib/payments/instruments.ts), so a stale value IS the price — and with
    // every control hidden, no field anywhere in the product could change it.
    // Measured on the live Mexican teacher 2026-08-30: her booking page
    // advertised 2,600 / 1,450 / 6,400 while the transfer rail took
    // 2,500 / 1,300 / 6,000.
    //
    // Hiding a control is not clearing a value. The hidden input has to go out
    // empty so the single visible "Price" is what a student actually pays.
    act(() =>
      root.render(
        React.createElement(TemplatesForm, {
          initial: [{ ...ROW, transferPriceMinorUnits: 200000 }],
          payoutCountrySupported: false,
        }),
      ),
    );
    expect(wiseDiscountCheckbox(container)).toBeNull();
    const wise = container.querySelector<HTMLInputElement>('input[name="tpl_wise_price"]');
    expect(wise).not.toBeNull();
    expect(wise!.value).toBe("");
  });

  it("still carries an existing Wise price for a SUPPORTED country", () => {
    // The clearing above must be scoped to teachers with no card rail — a
    // Connect-circle teacher's transfer discount is a real, intended feature.
    act(() =>
      root.render(
        React.createElement(TemplatesForm, {
          initial: [{ ...ROW, transferPriceMinorUnits: 200000 }],
          payoutCountrySupported: true,
        }),
      ),
    );
    const wise = container.querySelector<HTMLInputElement>('input[name="tpl_wise_price"]');
    expect(wise!.value).toBe("2000");
  });
});
