// @vitest-environment jsdom
//
// Package pricing in a 0-DECIMAL currency (JPY, CLP, KRW, VND).
//
// The form's price fields converted minor→major with a hardcoded `/ 100` while
// the matching onChange already used the currency-aware `majorToMinorUnits`. In a
// 2-decimal currency the two agree and nothing looks wrong; in a 0-decimal one
// they disagree by 100x, so a teacher types 1500 and the field snaps to 15.
//
// Two of the four offenders were the HIDDEN inputs the server action reads
// (`tpl_price`, `tpl_wise_price`), so this submitted a wrong number rather than
// merely displaying one — a package priced at ¥1,500 saved as ¥15.
//
// pricing-currency-context.tsx already warned about precisely this ("a call
// site that omits the currency multiplies a 0-decimal price by 100"); the
// warning was about the WRITE half, and the read half had the same bug.
//
// CLP has been in the curated list since D-124, so a Chilean teacher on the
// manual rail could reach this before D-143; widening the card rail to Japan
// adds JPY.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

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
const { PricingCurrencyProvider } = await import("@/components/pricing-currency-context");

// ¥1,500 and a ¥1,400 transfer price. In JPY the minor unit IS the major unit,
// so these integers are already what the teacher typed.
const JPY_ROW: {
  id: string;
  name: string;
  subject: string | null;
  classCount: number;
  singleClass: boolean;
  classDurationMin: number;
  priceMinorUnits: number;
  transferPriceMinorUnits: number | null;
  expirationMonths: number;
} = {
  id: "tpl-1",
  name: "8 clases",
  subject: null,
  classCount: 8,
  singleClass: false,
  classDurationMin: 50,
  priceMinorUnits: 1_500,
  transferPriceMinorUnits: 1_400,
  expirationMonths: 1,
};

function render(root: Root, currency: string, row: typeof JPY_ROW) {
  act(() =>
    root.render(
      React.createElement(PricingCurrencyProvider, {
        currency,
        children: React.createElement(TemplatesForm, {
          initial: [row],
          payoutCountrySupported: true,
        }),
      }),
    ),
  );
}

function visiblePrice(container: HTMLElement): string | undefined {
  return container.querySelector<HTMLInputElement>('input[id^="price-"]')?.value;
}

function hiddenValue(container: HTMLElement, name: string): string | undefined {
  return container.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)?.value;
}

describe("TemplatesForm — zero-decimal currencies", () => {
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

  it("shows a JPY price as typed, not divided by 100", () => {
    render(root, "JPY", JPY_ROW);
    // The bug rendered "15".
    expect(visiblePrice(container)).toBe("1500");
  });

  it("SUBMITS the JPY price undivided — the half that actually lost money", () => {
    render(root, "JPY", JPY_ROW);
    expect(hiddenValue(container, "tpl_price")).toBe("1500");
    expect(hiddenValue(container, "tpl_wise_price")).toBe("1400");
  });

  it("still divides by 100 for a 2-decimal currency", () => {
    // The regression risk in the other direction: MXN must keep behaving as it
    // always did, or every existing teacher's prices move by 100x.
    render(root, "MXN", { ...JPY_ROW, priceMinorUnits: 240_000, transferPriceMinorUnits: 230_000 });
    expect(visiblePrice(container)).toBe("2400");
    expect(hiddenValue(container, "tpl_price")).toBe("2400");
    expect(hiddenValue(container, "tpl_wise_price")).toBe("2300");
  });

  it("keeps an absent transfer price absent rather than sending 0", () => {
    // "" means "no discount"; 0 would mean "this package is free on the
    // transfer rail", which checkout would honour.
    render(root, "JPY", { ...JPY_ROW, transferPriceMinorUnits: null });
    expect(hiddenValue(container, "tpl_wise_price")).toBe("");
  });
});
