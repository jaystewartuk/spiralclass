import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";

(globalThis as Record<string, unknown>).React = React;

// One lead, as it actually renders — against the REAL string catalog rather
// than a `key => key` stub, because half of what this surface gets wrong is
// the words. The rest is the properties a screen full of these has to hold:
// every control says WHOSE lead it acts on, contact links are real links, and
// an archived lead offers no way to write to someone she has closed out.

vi.mock("@/app/actions/leads", () => ({ setLeadStatus: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const { LocaleProvider } = await import("@/components/locale-provider");
const { LeadGroup, LeadRow } = await import("@/app/(app)/dashboard/leads/lead-list");
type LeadListModule = typeof import("@/app/(app)/dashboard/leads/lead-list");
type LeadItem = Parameters<LeadListModule["LeadRow"]>[0]["lead"];
type LeadContext = Parameters<LeadListModule["LeadRow"]>[0]["ctx"];

const NOW = new Date("2026-09-02T18:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR);

const ctx: LeadContext = {
  t: createT("en"),
  locale: "en",
  timezone: "America/Mexico_City",
  now: NOW,
  replySubject: "About your classes",
};

const lead = (overrides: Partial<LeadItem> = {}): LeadItem => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "María José",
  email: "maria.jose@example.mx",
  phoneE164: "+525512345678",
  message: null,
  status: "new",
  createdAt: hoursAgo(2),
  ...overrides,
});

const render = (item: LeadItem, context: LeadContext = ctx) =>
  renderToStaticMarkup(
    <LocaleProvider locale="en">
      <LeadRow lead={item} ctx={context} />
    </LocaleProvider>,
  );

describe("LeadRow", () => {
  it("names the person in every control's accessible name", () => {
    // A screen-reader user tabbing twenty leads otherwise hears "Archive"
    // twenty times with nothing to say which row it belongs to.
    const html = render(lead());
    expect(html).toContain('aria-label="Reply to María José by email"');
    expect(html).toContain('aria-label="Message María José on WhatsApp"');
    expect(html).toContain('aria-label="Mark María José as contacted"');
    expect(html).toContain('aria-label="Archive María José"');
  });

  it("carries the reply subject the PAGE resolved, not the dashboard locale", () => {
    // The subject is written in the language of her booking page — the person
    // receiving it read the page, not the app.
    const html = render(lead(), { ...ctx, replySubject: "Sobre tus clases" });
    expect(html).toContain("mailto:maria.jose%40example.mx?subject=Sobre%20tus%20clases");
  });

  it("links WhatsApp by digits only, and omits it with no number", () => {
    expect(render(lead())).toContain("https://wa.me/525512345678");
    expect(render(lead({ phoneE164: null }))).not.toContain("wa.me");
  });

  it("offers no way to contact someone she has archived", () => {
    const html = render(lead({ status: "archived" }));
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("wa.me");
    expect(html).toContain('aria-label="Restore María José"');
  });

  it("offers a way back out of `converted`, which had none", () => {
    const html = render(lead({ status: "converted" }));
    expect(html).toContain("Reopen");
    // ...and does not offer the same transition under a label that reads as a
    // mistake on a lead who has already bought.
    expect(html).not.toContain("Mark contacted");
  });

  it("stays quiet about a fresh enquiry and escalates an old one", () => {
    expect(render(lead({ createdAt: hoursAgo(2) }))).not.toContain("Waiting");
    expect(render(lead({ createdAt: hoursAgo(30) }))).toContain("Waiting 1 day");
    expect(render(lead({ createdAt: hoursAgo(96) }))).toContain("Waiting 4 days");
  });

  it("never nags her about silence that is not hers", () => {
    expect(render(lead({ status: "contacted", createdAt: hoursAgo(500) }))).not.toContain(
      "Waiting",
    );
  });

  it("switches from a relative age to a real date once relative stops helping", () => {
    expect(render(lead({ createdAt: hoursAgo(3) }))).toContain("3 hours ago");
    expect(render(lead({ createdAt: hoursAgo(24 * 40) }))).toContain("Jul 24");
  });

  it("adds the year only once the date leaves this one", () => {
    // The shared helper spends the year where it buys something: "2026" on
    // every row during 2026 is noise, while a bare "Jul 24" on a lead from two
    // years ago is a genuine misreading. This branch briefly carried its own
    // always-show-the-year copy of the helper; there is one now.
    expect(render(lead({ createdAt: hoursAgo(24 * 40) }))).not.toContain("Jul 24, 2026");
    expect(render(lead({ createdAt: hoursAgo(24 * 400) }))).toContain("2025");
  });

  it("exposes the exact instant to machines even when the text is approximate", () => {
    const createdAt = hoursAgo(3);
    // React SSR emits the JSX prop name verbatim; HTML attribute names are
    // case-insensitive, so the browser reads it as `datetime` either way.
    expect(render(lead({ createdAt }))).toContain(`dateTime="${createdAt.toISOString()}"`);
  });

  it("labels the row's heading so the article that wraps it has a name", () => {
    const html = render(lead());
    expect(html).toContain('aria-labelledby="lead-11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('id="lead-11111111-1111-4111-8111-111111111111"');
  });
});

describe("LeadGroup", () => {
  it("renders nothing at all when its half of the working set is empty", () => {
    // The open view asks for both groups unconditionally; a card headed
    // "Needs a reply" with nothing under it is worse than no card.
    const html = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <LeadGroup title="Needs a reply" leads={[]} ctx={ctx} />
      </LocaleProvider>,
    );
    expect(html).toBe("");
  });

  it("only draws a heading when it was given one", () => {
    const withHeading = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <LeadGroup title="Needs a reply" leads={[lead()]} ctx={ctx} />
      </LocaleProvider>,
    );
    const without = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <LeadGroup leads={[lead()]} ctx={ctx} />
      </LocaleProvider>,
    );
    expect(withHeading).toContain("Needs a reply");
    expect(without).not.toContain("<h2");
  });
});
