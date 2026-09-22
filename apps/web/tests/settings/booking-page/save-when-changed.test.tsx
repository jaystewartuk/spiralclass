import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;

// Headline and bio are the only two fields on this screen behind a Save button.
// Both used to offer an enabled Save on arrival, before anything had been
// typed — a button whose only possible effect was to write back the value
// already stored. It now reflects whether there is anything to save.

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

const submitButton = (html: string) => /<button[^>]*type="submit"[^>]*>/.exec(html)?.[0] ?? "";

describe("Save is inert until something changes", () => {
  it("disables Save on a headline that has not been touched", () => {
    const html = renderToStaticMarkup(
      React.createElement(HeadlineForm, { initialHeadline: "Clases divertidas" }),
    );
    expect(submitButton(html)).toContain("disabled");
  });

  it("disables Save on an empty headline, where the only edit would be a no-op", () => {
    const html = renderToStaticMarkup(React.createElement(HeadlineForm, { initialHeadline: null }));
    expect(submitButton(html)).toContain("disabled");
  });

  it("disables Save on an untouched bio", () => {
    const html = renderToStaticMarkup(React.createElement(BioForm, { initialBio: "Hola." }));
    expect(submitButton(html)).toContain("disabled");
  });

  it("still renders the field itself as editable", () => {
    const html = renderToStaticMarkup(React.createElement(BioForm, { initialBio: "Hola." }));
    expect(html).toContain('name="bio"');
    // `\sdisabled(=|\s|>)` and not just `disabled`: the class attribute
    // carries `disabled:cursor-not-allowed`, which any looser pattern hits.
    expect(html).not.toMatch(/<textarea[^>]*\sdisabled(=|\s|>)/);
  });
});
