// @vitest-environment jsdom
//
// The package editor as /settings/templates renders it. The decisions behind
// it (what counts as an unsaved change, per-row validation, the per-class
// price) are unit-tested directly in tests/pricing/package-editor.test.ts;
// what is pinned here is the wiring only the rendered form can get wrong.
//
// Three of these are regressions, not features:
//
//   * A collapsed row must keep POSTING. The action reads index-aligned
//     `tpl_*` arrays, so a row whose fields unmounted when it closed would not
//     just lose its own values — it would shift every later row's onto the
//     wrong package.
//   * The saving line must be denominated in the TEACHER's currency.
//     `formatMinorUnits` defaults to MXN and this call site passed nothing, so a
//     GBP teacher was told her student saves pesos.
//   * A removed row must stay in the payload with `tpl_keep=0`, which is how
//     the server learns to archive it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// The rows render Radix Checkboxes, whose size hook wants a ResizeObserver
// jsdom doesn't implement. Nothing here measures anything.
(globalThis as Record<string, unknown>).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Echo the key AND its interpolation vars, so a test can assert what was
// passed into a string rather than only that some string was chosen.
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}|${JSON.stringify(vars)}` : key,
}));
vi.mock("@/app/actions/onboarding", () => ({ saveTemplatesAction: vi.fn() }));

const { TemplatesForm } = await import("@/app/(app)/onboarding/templates/templates-form");
const { PricingCurrencyProvider } = await import("@/components/pricing-currency-context");

const ROW = {
  id: "tpl-1",
  name: "8 classes / 2 months",
  subject: "Conversation",
  classCount: 8,
  singleClass: false,
  classDurationMin: 50,
  priceMinorUnits: 240_000,
  transferPriceMinorUnits: null as number | null,
  expirationMonths: 2,
};

type Props = Partial<React.ComponentProps<typeof TemplatesForm>>;

function hidden(container: HTMLElement, name: string): string[] {
  return Array.from(
    container.querySelectorAll<HTMLInputElement>(`input[type="hidden"][name="${name}"]`),
  ).map((el) => el.value);
}

function buttonWithText(container: HTMLElement, needle: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(needle),
  );
}

describe("TemplatesForm — the settings surface", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (props: Props = {}, currency = "MXN") =>
    act(() =>
      root.render(
        <PricingCurrencyProvider currency={currency}>
          <TemplatesForm
            initial={[ROW]}
            payoutCountrySupported
            stickyActions
            redirectTo="/settings/templates"
            {...props}
          />
        </PricingCurrencyProvider>,
      ),
    );

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

  it("titles a row with the package's own name, not its position", () => {
    render();
    // "Package 1" told a teacher with four near-identical offers nothing at all.
    expect(container.textContent).toContain("8 classes / 2 months");
    expect(container.textContent).not.toContain("web.onboarding.templates.packageN");
  });

  it("shows what one class costs inside the package", () => {
    render();
    // 240,000 centavos over 8 classes.
    expect(container.textContent).toContain("web.packages.perClass");
    expect(container.textContent).toContain("300.00");
  });

  it("keeps a collapsed row's payload intact — the fields hide, they never unmount", () => {
    render();
    // Nothing is open on first render, and the action must still receive
    // every field for every row, in order.
    expect(container.querySelector('[id^="pkg-panel-"]')?.hasAttribute("hidden")).toBe(true);
    expect(hidden(container, "tpl_id")).toEqual(["tpl-1"]);
    expect(hidden(container, "tpl_name")).toEqual(["8 classes / 2 months"]);
    expect(hidden(container, "tpl_class_count")).toEqual(["8"]);
    expect(hidden(container, "tpl_duration")).toEqual(["50"]);
    expect(hidden(container, "tpl_price")).toEqual(["2400"]);
    expect(hidden(container, "tpl_expiration")).toEqual(["2"]);
    expect(hidden(container, "tpl_keep")).toEqual(["1"]);
  });

  it("denominates the transfer saving in the teacher's own currency", () => {
    render({ initial: [{ ...ROW, transferPriceMinorUnits: 230_000 }] }, "GBP");
    const savings = container.textContent ?? "";
    expect(savings).toContain("onboarding.templates.wiseSavings");
    expect(savings).toContain("GBP");
    expect(savings).not.toContain("MXN");
  });

  it("keeps a removed row in the payload as keep=0, and offers an undo", () => {
    render();
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="web.packages.removeAria"]',
    );
    expect(remove).toBeTruthy();
    act(() => remove!.click());

    // Still posted — this is how the server learns to archive it.
    expect(hidden(container, "tpl_id")).toEqual(["tpl-1"]);
    expect(hidden(container, "tpl_keep")).toEqual(["0"]);
    expect(container.textContent).toContain("web.onboarding.templates.undoRemove");

    // ...and reversible, with no confirmation dialog in the way: nothing is
    // destroyed until she saves.
    const undo = buttonWithText(container, "web.onboarding.templates.undoRemove");
    act(() => undo!.click());
    expect(hidden(container, "tpl_keep")).toEqual(["1"]);
  });

  it("counts unsaved changes once a row is removed", () => {
    render();
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="web.packages.removeAria"]',
    );
    act(() => remove!.click());
    expect(container.textContent).toContain('web.packages.unsaved|{"count":1}');
  });

  it("says nothing about unsaved work before anything is touched", () => {
    render();
    expect(container.textContent).not.toContain("web.packages.unsaved");
  });

  it("names how many students keep their classes when a sold package is removed", () => {
    render({ soldByTemplateId: { "tpl-1": 3 } });
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="web.packages.removeAria"]',
    );
    act(() => remove!.click());
    expect(container.textContent).toContain('web.packages.removedSold|{"count":3}');
  });

  it("refuses to add past the plan cap, and says why", () => {
    render({ cap: 1 });
    const add = buttonWithText(container, "onboarding.templates.add");
    expect(add?.disabled).toBe(true);
    expect(container.textContent).toContain("web.packages.capReached");
  });

  it("adds freely when the plan is unlimited", () => {
    render({ cap: null });
    const add = buttonWithText(container, "onboarding.templates.add");
    expect(add?.disabled).toBe(false);
    act(() => add!.click());
    expect(hidden(container, "tpl_id")).toEqual(["tpl-1", ""]);
    // A row added this session posts keep=1 and carries the blank-draft shape.
    expect(hidden(container, "tpl_keep")).toEqual(["1", "1"]);
  });

  it("drops a never-saved row outright rather than posting an empty archive", () => {
    render({ cap: null });
    act(() => buttonWithText(container, "onboarding.templates.add")!.click());
    const removes = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="web.packages.removeAria"]',
    );
    act(() => removes[removes.length - 1].click());
    expect(hidden(container, "tpl_id")).toEqual(["tpl-1"]);
  });

  it("offers an empty state with a way out when there is nothing to edit", () => {
    render({ initial: [] });
    expect(container.textContent).toContain("web.packages.emptyTitle");
    expect(container.textContent).toContain("web.packages.emptyCta");
  });

  it("hides the transfer-price split entirely outside the Connect circle", () => {
    render({
      initial: [{ ...ROW, transferPriceMinorUnits: 230_000 }],
      payoutCountrySupported: false,
    });
    expect(container.querySelector('button[id^="wise-discount-"]')).toBeNull();
    // And the stale value is dropped rather than left to price the checkout
    // from a control no longer on the screen.
    expect(hidden(container, "tpl_wise_price")).toEqual([""]);
  });
});
