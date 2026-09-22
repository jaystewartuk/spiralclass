import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";

(globalThis as Record<string, unknown>).React = React;

// /settings/notifications — the structure, and the four defects the rewrite
// fixed. Rendered against the REAL catalog, like the account-page test: on a
// settings screen the grouping is copy as much as it is markup.

vi.mock("@/components/locale-provider", () => ({
  useT: () => createT("en"),
  useLocale: () => "en",
}));

const { NotificationPrefsForm } = await import("@/components/account/notification-prefs-form");

const t = createT("en");
const PAGE_SOURCE = readFileSync(
  resolve(__dirname, "../../src/app/(app)/settings/notifications/page.tsx"),
  "utf8",
);
const STUDENT_PAGE_SOURCE = readFileSync(
  resolve(__dirname, "../../src/app/(student)/my-classes/account/page.tsx"),
  "utf8",
);

/** The teacher form, rendered with everything reachable. */
function renderTeacherForm(channels: {
  emailOptIn: boolean;
  pushOptIn: boolean;
  hasPushDevice: boolean;
}) {
  return renderToStaticMarkup(
    React.createElement(NotificationPrefsForm, {
      role: "teacher" as const,
      action: async () => ({ ok: true }),
      initialPrefs: {},
      channels,
      deviceSlot: React.createElement("div", { "data-testid": "device-slot" }),
    }),
  );
}

const REACHABLE = { emailOptIn: true, pushOptIn: true, hasPushDevice: true };

/** Catalog copy is full of apostrophes, which the renderer escapes. */
function text(html: string): string {
  return html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

describe("the notifications settings page", () => {
  it("groups the screen instead of stacking peer cards", () => {
    // It was three sibling <Card>s whose CardTitles render at text-2xl — the
    // page <h1>'s own size — so the title and all three card headings were
    // four equal shouts. SettingsSection descends the scale and names the
    // group as a landmark, exactly as /settings/account does.
    expect(PAGE_SOURCE).toContain("SettingsSection");
    expect(PAGE_SOURCE).not.toMatch(/<CardTitle/);
  });

  it("anchors every quick-jump entry at a section that always renders", () => {
    const navIds = [...PAGE_SOURCE.matchAll(/\{ id: "([a-z-]+)", label:/g)].map((m) => m[1]);
    expect(navIds).toEqual(["preferences", "schedule", "students"]);
    for (const id of navIds) {
      expect(PAGE_SOURCE).toContain(`id="${id}"`);
    }
  });

  it("passes the teacher's own prefs to her schedule, and none to her students'", () => {
    // Her own list reports whether each group currently reaches her. Her
    // students' cannot — every student has their own preferences, so there is
    // no single state to state.
    expect(PAGE_SOURCE).toContain('<NotificationSchedule audience="teacher" prefs={prefs} />');
    expect(PAGE_SOURCE).toContain('<NotificationSchedule audience="student" />');
  });

  it("renders the browser-push control inside the form, on both screens", () => {
    // The push opt-in's hint says to turn notifications on "below". It used to
    // mean a different card; it now means the row underneath. Both callers
    // pass it as the form's deviceSlot rather than as a sibling block.
    //
    // Matched as "inside the deviceSlot" rather than as one exact line: the
    // slot holds the install row beside the toggle now, and pinning the
    // literal string made adding anything there a failing test about nothing.
    for (const source of [PAGE_SOURCE, STUDENT_PAGE_SOURCE]) {
      const slot = source.match(/deviceSlot=\{[\s\S]*?\n\s*\}\}?/)?.[0] ?? "";
      expect(slot).toContain("<WebPushToggle />");
    }
    expect(STUDENT_PAGE_SOURCE).not.toMatch(/<SettingsRow>\s*<WebPushToggle \/>/);
  });

  it("offers the install beside the push control, and nowhere else", () => {
    // Chosen scope: the one place being installed does something concrete for
    // the reader — it is what keeps push arriving with the browser closed —
    // rather than a banner on every page, which would be the same ask Chrome's
    // own mini-infobar already makes.
    for (const source of [PAGE_SOURCE, STUDENT_PAGE_SOURCE]) {
      const slot = source.match(/deviceSlot=\{[\s\S]*?\n\s*\}\}?/)?.[0] ?? "";
      expect(slot).toContain("<PwaInstallRow />");
    }
  });
});

describe("NotificationPrefsForm — the three layers", () => {
  it("puts the master switches ABOVE the per-category choices they override", () => {
    const html = renderTeacherForm(REACHABLE);
    const reach = html.indexOf(t("web.notificationPrefs.reach.title"));
    const which = html.indexOf(t("web.notificationPrefs.whichNotifications"));
    const firstCategory = html.indexOf(t("web.notificationPrefs.category.classReminders"));
    expect(reach).toBeGreaterThan(-1);
    // The order used to be the reverse: per-category chips first, then the
    // global opt-ins that silently override them, then — on another card
    // entirely — the browser permission that makes push possible at all.
    expect(reach).toBeLessThan(which);
    expect(which).toBeLessThan(firstCategory);
  });

  it("warns when both channels are off, instead of leaving it implied", () => {
    const html = text(
      renderTeacherForm({ emailOptIn: false, pushOptIn: false, hasPushDevice: false }),
    );
    expect(html).toContain(t("web.notificationPrefs.unreachable"));
    expect(text(renderTeacherForm(REACHABLE))).not.toContain(
      t("web.notificationPrefs.unreachable"),
    );
  });

  it("warns a teacher that email off silences the notices she cannot opt out of", () => {
    // Payment, Stripe and billing notices are non-suppressible AND email-only
    // (see the teacher channel note on the schedule) — the one combination
    // where turning a channel off loses mail there is no other route for.
    const html = text(
      renderTeacherForm({ emailOptIn: false, pushOptIn: true, hasPushDevice: true }),
    );
    expect(html).toContain(t("web.notificationPrefs.emailOffCritical"));
    expect(html).toContain(t("web.notificationPrefs.emailOffNote"));
  });

  it("gives every channel chip a 44px target and a non-colour state signal", () => {
    const html = renderTeacherForm(REACHABLE);
    // They were `px-2 py-0.5 text-xs` — roughly 20px against D-140's 44px
    // floor — and carried their state in a fill colour alone.
    expect(html).not.toContain("py-0.5");
    const chips = [...html.matchAll(/<button[^>]*aria-pressed="[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) expect(chip).toContain("h-11");
    // A check mark, not just a fill: colour is never the only signal (D-140).
    const onChip = chips.find((c) => c.includes('aria-pressed="true"')) ?? "";
    expect(html.slice(html.indexOf(onChip) + onChip.length)).toMatch(/^<svg[^>]*opacity-100/);
  });

  it("names each chip by its channel AND its category", () => {
    const html = renderTeacherForm(REACHABLE);
    // "Email" alone is ambiguous in a list of nine rows that each have one.
    expect(html).toContain(
      t("web.notificationPrefs.channelToggle.label", {
        channel: t("web.notificationPrefs.channel.email"),
        category: t("web.notificationPrefs.category.classReminders"),
      }),
    );
  });

  it("starts with Save disabled, because nothing has changed yet", () => {
    const html = renderTeacherForm(REACHABLE);
    const save = /<button[^>]*type="submit"[^>]*>/.exec(html)?.[0] ?? "";
    expect(save).toContain("disabled");
    expect(html).not.toContain(t("web.notificationPrefs.unsavedChanges"));
  });
});

describe("category copy", () => {
  it("separates a category's name from its explanation", () => {
    // Every label carried its own parenthetical — "Student progress
    // (post-class review nudges, finished packages)" — which made the list
    // unscannable and gave the explanation the weight of the thing explained.
    for (const key of [
      "web.notificationPrefs.category.studentProgress",
      "web.notificationPrefs.category.classActivity",
      "web.notificationPrefs.category.bookingUpdates",
      "web.notificationPrefs.category.expiryReminders",
      "web.notificationPrefs.category.subscription",
      "web.notificationPrefs.category.growth",
    ] as const) {
      expect(t(key), `${key} still carries a parenthetical`).not.toContain("(");
    }
  });

  it("no longer describes the growth category as posting in Facebook groups", () => {
    // D-125 replaced that job with the week's prepared acquisition plan. The
    // schedule row was updated at the time; this label was not, and had been
    // promising a feature that no longer exists ever since.
    const growth = `${t("web.notificationPrefs.category.growth")} ${t(
      "web.notificationPrefs.categoryHint.growth",
    )}`;
    expect(growth).not.toMatch(/facebook/i);
    expect(growth).toMatch(/weekly plan/i);
  });
});
