import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// Headline/bio character counters (production-polish pass): a live "x / max"
// count sourced from the shared HEADLINE_MAX_LENGTH/BIO_MAX_LENGTH constants,
// wired via aria-describedby so screen readers pick it up alongside the help
// text. maxLength on the field itself is the actual prevent-exceed mechanism.

vi.mock("@/app/actions/profile", () => ({
  saveHeadlineAction: vi.fn(),
  saveBioAction: vi.fn(),
}));
vi.mock("@/components/locale-provider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => "en",
}));

const { HeadlineForm } = await import("@/app/(app)/settings/booking-page/headline-form");
const { BioForm } = await import("@/app/(app)/settings/booking-page/bio-form");

describe("HeadlineForm — character counter", () => {
  it("shows the seeded value's length against the 80-char shared limit", () => {
    const html = renderToStaticMarkup(
      React.createElement(HeadlineForm, { initialHeadline: "Clases divertidas" }),
    );
    expect(html).toContain("17 / 80");
    expect(html).toContain('maxLength="80"');
  });

  it("starts at 0 / 80 with no headline yet", () => {
    const html = renderToStaticMarkup(React.createElement(HeadlineForm, { initialHeadline: null }));
    expect(html).toContain("0 / 80");
  });

  it("wires the counter into the field's accessible description", () => {
    const html = renderToStaticMarkup(React.createElement(HeadlineForm, { initialHeadline: null }));
    expect(html).toContain('id="headline-counter"');
    expect(html).toMatch(/aria-describedby="[^"]*headline-counter[^"]*"/);
  });
});

describe("BioForm — character counter", () => {
  it("shows the seeded value's length against the 280-char shared limit", () => {
    const bio = "x".repeat(42);
    const html = renderToStaticMarkup(React.createElement(BioForm, { initialBio: bio }));
    expect(html).toContain("42 / 280");
    expect(html).toContain('maxLength="280"');
  });

  it("wires the counter into the field's accessible description", () => {
    const html = renderToStaticMarkup(React.createElement(BioForm, { initialBio: null }));
    expect(html).toContain('id="bio-counter"');
    expect(html).toMatch(/aria-describedby="[^"]*bio-counter[^"]*"/);
  });
});
