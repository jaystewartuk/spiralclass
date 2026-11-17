// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";

(globalThis as Record<string, unknown>).React = React;

vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: async () => "en",
  getT: async () => createT("en"),
}));

const { default: DemoPage } = await import("@/app/demo/page");
const { DashboardView } = await import("@/components/dashboard/dashboard-view");
const { EarningsTile } = await import("@/components/cashflow-summary");
const { LocaleProvider } = await import("@/components/locale-catalog");
const { CopyLinkButton } = await import("@/components/copy-link-button");
type ViewModel = React.ComponentProps<typeof DashboardView>;

// Render the actual public fixture and its nested controls. Only the async
// server tile needs resolving before React's synchronous markup renderer;
// GrowthChecklist and CopyLinkButton stay real, including their disabled state.
async function resolveEarnings(node: React.ReactNode): Promise<React.ReactNode> {
  if (Array.isArray(node))
    return React.Children.toArray(await Promise.all(node.map(resolveEarnings)));
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return node;
  if (node.type === EarningsTile) {
    return EarningsTile(node.props as React.ComponentProps<typeof EarningsTile>);
  }
  if (!node.props.children) return node;
  return React.cloneElement(node, {}, await resolveEarnings(node.props.children));
}

async function dashboard(readOnly?: boolean) {
  const page = await DemoPage();
  const fixture = React.Children.toArray(page.props.children).find(
    (node) => React.isValidElement(node) && node.type === DashboardView,
  ) as React.ReactElement<ViewModel>;
  expect(fixture.props.readOnly).toBe(true);
  const view = await resolveEarnings(await DashboardView({ ...fixture.props, readOnly }));
  const doc = document.implementation.createHTMLDocument();
  doc.body.innerHTML = renderToStaticMarkup(<LocaleProvider locale="en">{view}</LocaleProvider>);
  return doc;
}

describe("the public dashboard demo", () => {
  it("shows the real schedule, growth and earnings without any working controls", async () => {
    const doc = await dashboard(true);
    expect(doc.body.textContent).toContain("Mariana Duarte");
    expect(doc.body.textContent).toContain("Your earnings");
    expect(doc.body.textContent).toContain("WhatsApp");
    expect(doc.body.textContent).toContain("Facebook");
    expect(doc.body.textContent).toContain("See every month");
    expect(doc.querySelectorAll("button").length).toBeGreaterThan(0);
    expect(doc.querySelectorAll("button:not(:disabled)")).toHaveLength(0);
    expect(doc.querySelectorAll("a[href]")).toHaveLength(0);
  });

  it("keeps normal teacher navigation, copying and sharing available by default", async () => {
    const doc = await dashboard();
    expect(doc.querySelector('a[href^="/settings/"]')).not.toBeNull();
    expect(doc.querySelector('a[href="/payments#earned-by-month"]')).not.toBeNull();
    expect(doc.querySelector('a[href^="https://wa.me/"]')).not.toBeNull();
    expect(doc.querySelectorAll("button:not(:disabled)").length).toBeGreaterThan(0);
    const copy = [...doc.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Copy");
    expect(copy?.disabled).toBe(false);
  });

  it.each([false, true])("disables either copy-button presentation (iconOnly=%s)", (iconOnly) => {
    const html = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <CopyLinkButton value="https://example.test/fixture" disabled iconOnly={iconOnly} />
      </LocaleProvider>,
    );
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = html;
    expect(doc.querySelector("button")?.disabled).toBe(true);
  });
});
