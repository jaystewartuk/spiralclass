import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";

(globalThis as Record<string, unknown>).React = React;

// The account settings page's structure, and the two defects the restructure
// fixed. Rendered against the REAL catalog, like the billing-page test: the
// grouping is copy as much as it is markup.

vi.mock("@/components/locale-provider", () => ({
  useT: () => createT("en"),
  useLocale: () => "en",
}));

const { SettingsSection, SettingRow } = await import("@/components/ui/settings-section");
const { activeSectionId } = await import("@/components/ui/section-nav");
const { ToggleSetting } = await import("@/components/ui/toggle-setting");

const t = createT("en");
const PAGE_SOURCE = readFileSync(
  resolve(__dirname, "../../src/app/(app)/settings/account/page.tsx"),
  "utf8",
);

describe("SettingsSection", () => {
  type SectionProps = React.ComponentProps<typeof SettingsSection>;
  const render = (props: Partial<SectionProps> = {}) =>
    renderToStaticMarkup(
      React.createElement<SectionProps>(
        SettingsSection,
        { id: "profile", title: "Profile", description: "Who you are.", children: null, ...props },
        React.createElement(SettingRow, { title: "My details" }, "body"),
      ),
    );

  it("names its landmark with the heading it already has", () => {
    const html = render();
    // aria-labelledby pointing at a real id, rather than an aria-label that
    // duplicates the same words somewhere they can drift apart.
    expect(html).toContain('aria-labelledby="profile-heading"');
    expect(html).toContain('id="profile-heading"');
    expect(html).toContain('<section id="profile"');
  });

  it("descends the type scale rather than repeating the page heading's size", () => {
    const html = render();
    // Section 19px (h3 step) over row 17px (base) — and never `text-2xl`,
    // which is the page title's own size and what every card used to render.
    expect(html).toMatch(/<h2[^>]*class="[^"]*text-h3/);
    expect(html).toMatch(/<h3[^>]*class="[^"]*text-base/);
    expect(html).not.toContain("text-2xl");
  });

  it("outlines the danger group, and only the danger group", () => {
    expect(render({ tone: "danger" })).toContain("border-destructive");
    expect(render()).not.toContain("border-destructive");
  });
});

describe("activeSectionId", () => {
  const ids = ["profile", "sign-in", "classes"];

  it("takes the first visible section in document order", () => {
    // Not `entries[0]` — an IntersectionObserver callback carries only what
    // CHANGED, in no guaranteed order, so a set built from it can arrive in
    // any order and the answer must not depend on that.
    expect(activeSectionId(ids, new Set(["classes", "sign-in"]))).toBe("sign-in");
    expect(activeSectionId(ids, new Set(["sign-in", "classes"]))).toBe("sign-in");
  });

  it("falls back to the first section when nothing is on screen", () => {
    expect(activeSectionId(ids, new Set())).toBe("profile");
    expect(activeSectionId([], new Set())).toBeUndefined();
  });
});

describe("ToggleSetting", () => {
  const html = renderToStaticMarkup(
    React.createElement(ToggleSetting, {
      name: "autoRecordClasses",
      action: async () => ({ ok: true }),
      initialEnabled: true,
      label: "Start recording automatically",
      hint: "Both parties still see the indicator.",
      savingLabel: "Saving…",
      savedLabel: "Saved.",
    }),
  );

  it("posts nothing at all when off, so the preference can be turned off", () => {
    // The regression: both toggles mirrored their checkbox into
    // <input type="hidden" value={enabled ? "on" : ""}>. A hidden input always
    // submits, so the actions — which read PRESENCE, exactly as their own
    // tests assert — saw the field every time and wrote `true` forever.
    expect(html).not.toContain('type="hidden"');
  });

  it("gives the checkbox an accessible name a label element can carry", () => {
    // Radix renders <button role="checkbox">; a WRAPPING <label> names
    // nothing. htmlFor/id does, and makes the words clickable too.
    const id = /<button[^>]*role="checkbox"[^>]*id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`for="${id}"`);
  });
});

describe("the account page", () => {
  it("does not render a second copy of the notification preferences", () => {
    // It used to, with `hasPushDevice` counted from a retired transport — so a
    // teacher whose browser push worked saw the push opt-in disabled here and
    // enabled on /settings/notifications. One setting, one page.
    // Matched on the import and the element, not any mention: the page's own
    // comment names the component to say why it is gone.
    expect(PAGE_SOURCE).not.toMatch(/^import[^;]*NotificationPrefsForm/m);
    expect(PAGE_SOURCE).not.toContain("<NotificationPrefsForm");
    expect(PAGE_SOURCE).toContain("/settings/notifications");
  });

  it("anchors every quick-jump entry at a section that always renders", () => {
    // The two optional ROWS (Google, recording) sit inside sections that have
    // another row regardless, so no pill can ever point at a missing anchor.
    const navIds = [...PAGE_SOURCE.matchAll(/\{ id: "([a-z-]+)", label:/g)].map((m) => m[1]);
    expect(navIds.length).toBeGreaterThan(1);
    for (const id of navIds) {
      expect(PAGE_SOURCE).toContain(`id="${id}"`);
    }
  });

  it("labels the quick-jump bar and its section headings from the catalog", () => {
    expect(t("web.settings.account.sectionNavLabel")).toBe("Account sections");
    expect(t("web.settings.account.sections.profile.title")).toBe("Profile");
    expect(t("web.settings.account.memberSince", { date: "March 2026" })).toBe(
      "With SpiralClass since March 2026",
    );
  });
});
