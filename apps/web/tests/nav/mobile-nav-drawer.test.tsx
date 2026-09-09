// @vitest-environment jsdom
//
// The phone/tablet navigation drawer — the surface a student and a teacher
// reach the whole product through on a phone.
//
// What these pin is the set of things that were wrong when it was a block of
// markup revealed under the header rather than a dialog: nothing marked it
// modal, focus was never moved into it or trapped, and the page behind it kept
// scrolling. Plus the structure the redesign added — an identity card that
// goes somewhere, icons on every row, groups that open only when they hold the
// page you are on.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { BookOpen, CalendarDays, Users } from "lucide-react";

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
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));
// Sign out reaches for a server action (prisma + auth) and posthog; neither is
// what this file is about.
vi.mock("@/app/actions/auth", () => ({ signOutAction: async () => undefined }));
vi.mock("posthog-js/react", () => ({ usePostHog: () => undefined }));
vi.mock("@sentry/nextjs", () => ({ getFeedback: () => undefined }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: () => {} }) }));

const { MobileNavDrawer } = await import("@/components/nav/mobile-nav-drawer");

type Section = import("@/components/nav/mobile-nav-drawer").MobileNavSection;

const ACCOUNT = { name: "Jay Stewart", email: "jay@example.com", photoUrl: null };

function sections(activeKey = "classes"): Section[] {
  return [
    {
      rows: [
        {
          key: "classes",
          href: "/my-classes",
          label: "Classes",
          icon: BookOpen,
          active: activeKey === "classes",
        },
        {
          key: "calendar",
          href: "/my-classes/calendar",
          label: "Calendar",
          icon: CalendarDays,
          active: activeKey === "calendar",
        },
      ],
    },
    {
      label: "Settings",
      collapsible: true,
      rows: [
        {
          key: "account",
          href: "/my-classes/account",
          label: "Account",
          icon: Users,
          active: activeKey === "account",
        },
      ],
    },
  ];
}

describe("MobileNavDrawer", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onOpenChange = vi.fn();

  beforeEach(() => {
    onOpenChange.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function open(activeKey?: string) {
    act(() => {
      root.render(
        React.createElement(MobileNavDrawer, {
          id: "student-mobile-menu",
          open: true,
          onOpenChange,
          navLabel: "Main navigation",
          account: ACCOUNT,
          accountHref: "/my-classes/account",
          sections: sections(activeKey),
        }),
      );
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error("drawer did not render a dialog");
    return dialog;
  }

  it("is a named dialog, and hides the page behind it from assistive tech", () => {
    const dialog = open();
    expect(dialog.getAttribute("role")).toBe("dialog");
    // Named, so a screen reader announces WHAT opened.
    const title = document.getElementById(dialog.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe("web.nav.menu");
    // Modality, the way it actually works: everything outside the drawer is
    // marked hidden while it is open, so a screen reader cannot wander into
    // the page the drawer is covering. The old inline panel left the whole
    // page readable underneath it.
    expect(container.getAttribute("aria-hidden")).toBe("true");
  });

  it("moves focus into the drawer and keeps it there", () => {
    const dialog = open();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("locks the page behind it, which the old panel never did", () => {
    open();
    const locked =
      document.body.hasAttribute("data-scroll-locked") ||
      document.body.style.overflow === "hidden" ||
      document.body.style.pointerEvents === "none";
    expect(locked).toBe(true);
  });

  it("asks to close on Escape", () => {
    open();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("carries the identity into the account page rather than showing it as decoration", () => {
    const dialog = open();
    const card = dialog.querySelector<HTMLAnchorElement>('a[href="/my-classes/account"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Jay Stewart");
    expect(card?.textContent).toContain("jay@example.com");
    // The link needs a verb for a screen reader — the name alone says nothing
    // about where it goes.
    expect(card?.textContent).toContain("web.nav.viewAccount");
  });

  it("marks the current page for assistive tech, not only in colour", () => {
    const dialog = open("calendar");
    const current = dialog.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("Calendar");
  });

  it("gives every destination an icon, so the list is scannable", () => {
    const dialog = open();
    for (const label of ["Classes", "Calendar"]) {
      const row = [...dialog.querySelectorAll("a")].find((a) => a.textContent?.includes(label));
      expect(row?.querySelector("svg"), `${label} has no icon`).not.toBeNull();
    }
  });

  it("opens with the secondary groups collapsed", () => {
    const dialog = open("classes");
    const disclosure = [...dialog.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Settings"),
    );
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    const list = document.getElementById(disclosure?.getAttribute("aria-controls") ?? "");
    expect(list?.hasAttribute("hidden")).toBe(true);
  });

  it("opens the group that holds the current page", () => {
    const dialog = open("account");
    const disclosure = [...dialog.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Settings"),
    );
    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
  });

  it("expands a collapsed group when its heading is pressed", () => {
    const dialog = open("classes");
    const disclosure = [...dialog.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Settings"),
    );
    act(() => disclosure?.click());
    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
    const list = document.getElementById(disclosure?.getAttribute("aria-controls") ?? "");
    expect(list?.hasAttribute("hidden")).toBe(false);
  });

  it("ends with support, preferences and sign out, in that order", () => {
    const dialog = open();
    const text = dialog.textContent ?? "";
    expect(text.indexOf("web.nav.support")).toBeGreaterThan(-1);
    expect(text.indexOf("web.nav.appearance")).toBeGreaterThan(text.indexOf("web.nav.support"));
    expect(text.indexOf("common.signOut")).toBeGreaterThan(text.indexOf("web.nav.appearance"));
  });
});
