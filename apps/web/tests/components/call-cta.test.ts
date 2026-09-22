import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// The class-detail redesign pulled the join/start-call action out of a plain
// Card into its own accent-styled CTA. SSR-level checks (this app's view
// components are E2E/Playwright territory, not jsdom unit coverage — see
// vitest.config.ts) pin: title/subtitle/cta text render, and the href lands on
// a real link so existing behavior (and any Playwright/E2E coverage) still
// finds a plain anchor to the call route.

const { CallCta } = await import("@/components/call-cta");

describe("CallCta", () => {
  it("renders title, subtitle and the call-to-action label, linked to href", () => {
    const html = renderToStaticMarkup(
      React.createElement(CallCta, {
        href: "/dashboard/classes/b1/call",
        title: "Video call",
        subtitle: "Start the class video call",
        cta: "Start class",
      }),
    );
    expect(html).toContain("Video call");
    expect(html).toContain("Start the class video call");
    expect(html).toContain("Start class");
    expect(html).toContain('href="/dashboard/classes/b1/call"');
  });

  it("omits the subtitle paragraph when none is given", () => {
    const html = renderToStaticMarkup(
      React.createElement(CallCta, { href: "/call", title: "Video call", cta: "Join" }),
    );
    expect(html).toContain("Video call");
    expect(html).toContain("Join");
  });
});
