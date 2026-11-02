// @vitest-environment jsdom
//
// The footer is on every public page, including a teacher's booking page, where
// it speaks for the product and not for whoever wrote it. It carries the brand's
// copyright line and no personal credit; the About page is where the product says
// who built it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRAND_NAME, CONTROLLER } from "@spiralclass/shared";

const stableT = (key: string) => key;
vi.mock("@/components/locale-provider", () => ({
  useT: () => stableT,
  useLocalizedHref: () => (href: string) => href,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/b/a-teacher" }));
vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }));

(globalThis as Record<string, unknown>).React = await import("react");
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { SiteFooter } = await import("@/components/site-footer");

describe("SiteFooter", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("carries the brand's copyright and no personal credit on a booking page", () => {
    act(() => root.render(<SiteFooter />));

    expect(host.textContent).toContain(`© ${new Date().getFullYear()} ${BRAND_NAME}`);
    expect(host.textContent).not.toContain(CONTROLLER.name);
    expect(host.textContent).not.toContain("web.siteFooter.madeBy");
    expect(host.querySelector('a[href*="jaystewart.co.uk"]')).toBeNull();
  });
});
