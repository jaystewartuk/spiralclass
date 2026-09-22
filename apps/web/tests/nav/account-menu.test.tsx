// @vitest-environment jsdom
//
// The desktop avatar menu. It is the same menu as the phone drawer — identity,
// destinations, support, preferences, sign out — in a popover, and these pin
// the two properties that were wrong before the redesign.
//
// The first is ARIA. It declared `role="menu"` with `role="menuitem"` links,
// which promises a screen-reader user the menu keyboard model over menu items;
// it implemented none of that model, and the panel also holds a <select>, a
// segmented control and a form, none of which are menu items. It is a
// disclosure now, and it behaves like one.
//
// The second is focus. Opening it left focus on the trigger and Escape was the
// only key it understood.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { Receipt, UserCog } from "lucide-react";

(globalThis as Record<string, unknown>).React = React;

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    prefetch: _prefetch,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    prefetch?: boolean;
  }) => React.createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings/account" }));
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("@/app/actions/auth", () => ({ signOutAction: async () => undefined }));
vi.mock("posthog-js/react", () => ({ usePostHog: () => undefined }));
vi.mock("@sentry/nextjs", () => ({ getFeedback: () => undefined }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: () => {} }) }));

const { AccountMenu } = await import("@/components/account-menu");

const LINKS = [
  { href: "/settings/account", label: "Account", active: true, icon: UserCog },
  { href: "/settings/billing", label: "Billing", active: false, icon: Receipt },
];

describe("AccountMenu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(AccountMenu, {
          account: { name: "Alicia Moreno", email: "mira@example.com" },
          accountHref: "/settings/account",
          linksLabel: "Settings",
          links: LINKS,
        }),
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const trigger = () => container.querySelector("button")!;
  const panel = () =>
    document.getElementById(trigger().getAttribute("aria-controls") ?? "") ?? undefined;
  const openMenu = () => {
    act(() => trigger().click());
    const found = panel();
    if (!found) throw new Error("menu did not open");
    return found;
  };
  const items = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLElement>("a, button, select")].filter((n) => !n.hidden);

  it("is a labelled disclosure, closed until it is asked for", () => {
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-label")).toBe("web.accountMenu.menuLabel");
    expect(panel()).toBeUndefined();
  });

  it("does not claim a menu role it cannot honour", () => {
    const el = openMenu();
    expect(el.getAttribute("role")).toBeNull();
    expect(el.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  });

  it("hands the first item focus when it opens", () => {
    const el = openMenu();
    expect(el.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(items(el)[0]);
  });

  it("moves between items with the arrow keys, and wraps", () => {
    const el = openMenu();
    const order = items(el);
    const press = (key: string) =>
      act(() => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });

    press("ArrowDown");
    expect(document.activeElement).toBe(order[1]);
    press("ArrowUp");
    expect(document.activeElement).toBe(order[0]);
    press("ArrowUp");
    expect(document.activeElement).toBe(order[order.length - 1]);
    press("Home");
    expect(document.activeElement).toBe(order[0]);
    press("End");
    expect(document.activeElement).toBe(order[order.length - 1]);
  });

  it("closes on Escape and gives the trigger its focus back", () => {
    openMenu();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(panel()).toBeUndefined();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("closes when focus leaves it entirely", () => {
    const el = openMenu();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => {
      items(el)[0].dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }),
      );
    });
    expect(panel()).toBeUndefined();
    outside.remove();
  });

  it("shows the same parts as the phone drawer, in the same order", () => {
    const el = openMenu();
    const text = el.textContent ?? "";
    // Identity first, then destinations, then support, preferences, sign out.
    // (The very first characters are the avatar monogram.)
    expect(text.indexOf("Alicia Moreno")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Settings")).toBeGreaterThan(text.indexOf("Alicia Moreno"));
    expect(text.indexOf("web.nav.support")).toBeGreaterThan(text.indexOf("Billing"));
    expect(text.indexOf("web.nav.appearance")).toBeGreaterThan(text.indexOf("web.nav.support"));
    expect(text.indexOf("common.signOut")).toBeGreaterThan(text.indexOf("web.nav.appearance"));
  });

  it("marks the current page and gives each destination its icon", () => {
    const el = openMenu();
    const current = el.querySelectorAll('a[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("Account");
    const billing = [...el.querySelectorAll("a")].find((a) => a.textContent?.includes("Billing"));
    expect(billing?.querySelector("svg")).not.toBeNull();
  });

  it("takes the identity card to the account page", () => {
    const el = openMenu();
    const card = items(el)[0] as HTMLAnchorElement;
    expect(card.getAttribute("href")).toBe("/settings/account");
    expect(card.textContent).toContain("web.nav.viewAccount");
  });
});
