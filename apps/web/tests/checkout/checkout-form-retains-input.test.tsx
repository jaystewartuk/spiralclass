// @vitest-environment jsdom
//
// A failed checkout must not make the buyer retype anything.
//
// React 19 RESETS an uncontrolled form as soon as its action resolves. Every
// error return from createCheckoutIntent therefore wiped the name and email
// the buyer had just entered. Nobody saw it while a Stripe failure threw to
// the error boundary — the whole page went, fields included — but once that
// failure started rendering inline (Sentry AGENDAPROFE-36) the reset became
// the visible behaviour: an inline "try again" above two empty, red-outlined
// required fields. Confirmed on preview before this test existed.
//
// The fix is that the action echoes the submitted values back and the form
// renders them as `defaultValue`, because a reset restores each input to its
// CURRENT default. That is a real React-semantics claim rather than an
// obvious one, so it is pinned here against the actual component: type,
// submit, fail, and assert the values are still in the inputs.
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

const createCheckoutIntent = vi.fn();
vi.mock("@/app/actions/checkout", () => ({
  createCheckoutIntent: (...args: unknown[]) => createCheckoutIntent(...args),
}));

vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn() }));
vi.mock("@stripe/react-stripe-js", () => ({
  EmbeddedCheckoutProvider: () => null,
  EmbeddedCheckout: () => null,
}));

const { CheckoutForm } = await import("@/app/b/[slug]/buy/checkout-form");

// React's onChange doesn't fire from a plain `.value =` assignment — it reads
// through the native setter it patched. Same trick the other interactive
// component tests in this repo use.
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CheckoutForm — a failed checkout keeps what the buyer typed", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    createCheckoutIntent.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    act(() => {
      root.render(
        React.createElement(CheckoutForm, {
          slug: "paula-pagos",
          templateId: "tpl-1",
          priceMinorUnits: 38_000,
          transferPriceMinorUnits: 36_100,
          currency: "MXN",
          method: "stripe" as const,
          instrumentId: null,
          instrumentKind: null,
          noMethods: false,
        }),
      );
    });
  }

  function fields() {
    const inputs = Array.from(container.querySelectorAll("input"));
    return {
      name: inputs.find((i) => i.name === "studentName") as HTMLInputElement,
      email: inputs.find((i) => i.name === "studentEmail") as HTMLInputElement,
      form: container.querySelector("form") as HTMLFormElement,
    };
  }

  it("leaves the name and email in place when the action returns an error", async () => {
    // What the wrapper in actions/checkout.ts returns for any failure.
    createCheckoutIntent.mockResolvedValue({
      error: "We couldn't reach the card provider just now.",
      values: { studentName: "Card Rail Test", studentEmail: "cardtest@example.com" },
    });

    render();
    const { name, email, form } = fields();
    typeInto(name, "Card Rail Test");
    typeInto(email, "cardtest@example.com");

    await act(async () => {
      form.requestSubmit();
    });

    const after = fields();
    expect(after.name.value).toBe("Card Rail Test");
    expect(after.email.value).toBe("cardtest@example.com");
    // ...and the buyer can see why, right there.
    expect(container.textContent).toContain("card provider");
  });

  it("shows the second attempt's values, not the first attempt's", async () => {
    // The echo is per-submission. A buyer who corrects a typo and fails again
    // must see the CORRECTED value, not the one the previous failure returned.
    render();
    const { name, email, form } = fields();

    createCheckoutIntent.mockResolvedValue({
      error: "Invalid data",
      values: { studentName: "Frist Try", studentEmail: "typo@example.com" },
    });
    typeInto(name, "Frist Try");
    typeInto(email, "typo@example.com");
    await act(async () => {
      form.requestSubmit();
    });
    expect(fields().name.value).toBe("Frist Try");

    createCheckoutIntent.mockResolvedValue({
      error: "Invalid data",
      values: { studentName: "First Try", studentEmail: "fixed@example.com" },
    });
    typeInto(fields().name, "First Try");
    typeInto(fields().email, "fixed@example.com");
    await act(async () => {
      fields().form.requestSubmit();
    });

    const after = fields();
    expect(after.name.value).toBe("First Try");
    expect(after.email.value).toBe("fixed@example.com");
  });
});
