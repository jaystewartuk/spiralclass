import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// The student account page's structure, which is the thing this screen gets
// wrong when it drifts. It carries on ONE page what the teacher gets as six
// separate settings pages, so its grouping is not decoration — it is the only
// navigation there is.
//
// Three invariants, each of which failed silently before:
//   1. A section is a landmark NAMED BY ITS OWN HEADING, so the list a screen
//      reader offers is the list the jump nav shows.
//   2. Sections are <h2> and rows are <h3>. Every card title on this page used
//      to render at `text-2xl`, the same size as the page's own <h1>.
//   3. Every chip in the jump nav points at a section that exists. A stale id
//      is a link that scrolls nowhere and reports nothing.

const { SettingsSection, SettingsRow } =
  await import("@/app/(student)/my-classes/account/settings-section");
const { SectionNav } = await import("@/app/(student)/my-classes/account/section-nav");

describe("SettingsSection", () => {
  const html = renderToStaticMarkup(
    React.createElement(SettingsSection, {
      id: "notifications",
      title: "Notifications",
      description: "Choose what you get.",
      children: React.createElement(SettingsRow, { children: "inner-child" }),
    }),
  );

  it("is a landmark named by its own heading", () => {
    expect(html).toContain('<section id="notifications"');
    expect(html).toContain('aria-labelledby="notifications-heading"');
    expect(html).toContain('id="notifications-heading"');
  });

  it("titles the section with an h2, one step under the page's h1", () => {
    expect(html).toMatch(/<h2[^>]*>Notifications<\/h2>/);
    expect(html).toContain("Choose what you get.");
    expect(html).toContain("inner-child");
  });

  it("clears the sticky chrome so a jump lands on the heading, not under it", () => {
    expect(html).toContain("scroll-mt-28");
  });
});

describe("SettingsRow", () => {
  it("titles a row with an h3, so the outline reads section then setting", () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsRow, {
        title: "Sign-in email",
        description: "We confirm the new address first.",
        children: "control",
      }),
    );
    expect(html).toMatch(/<h3[^>]*>Sign-in email<\/h3>/);
  });

  it("renders no heading at all when the row has no title", () => {
    // A section whose single row IS the section must not say the same thing
    // twice — the row carries the control and nothing else.
    const html = renderToStaticMarkup(React.createElement(SettingsRow, { children: "control" }));
    expect(html).not.toContain("<h3");
    expect(html).toContain("control");
  });

  it("marks an irreversible action, rather than leaving it to read as routine", () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsRow, {
        tone: "danger",
        title: "Delete account",
        children: "control",
      }),
    );
    expect(html).toContain("bg-destructive-bg");
    expect(html).toContain("text-destructive");
  });
});

describe("SectionNav", () => {
  const sections = [
    { id: "profile", label: "Profile" },
    { id: "data", label: "Your data" },
  ];
  const html = renderToStaticMarkup(
    React.createElement(SectionNav, { sections, label: "On this page" }),
  );

  it("is a named nav landmark, so it is reachable rather than just visible", () => {
    expect(html).toContain('aria-label="On this page"');
    expect(html).toContain('href="#profile"');
    expect(html).toContain('href="#data"');
  });

  it("marks exactly one chip current on first paint", () => {
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it("keeps a 44px target below desktop, where these are tapped", () => {
    expect(html).toContain("min-h-target");
  });
});

describe("the page's jump nav and its sections", () => {
  // A source-level check because the page is an async Server Component reading
  // Prisma — but the invariant is worth guarding anyway: these two lists are
  // written in two places and nothing else notices when they disagree.
  const source = readFileSync(
    resolve(__dirname, "../../src/app/(student)/my-classes/account/page.tsx"),
    "utf8",
  );
  const navIds = [...source.matchAll(/\{ id: "([a-z-]+)", label:/g)].map((match) => match[1]);
  const sectionIds = [...source.matchAll(/id="([a-z-]+)"\n\s+title=/g)].map((match) => match[1]);

  it("names the same six sections in both places, in the same order", () => {
    expect(navIds.length).toBe(6);
    expect(sectionIds).toEqual(navIds);
  });
});
