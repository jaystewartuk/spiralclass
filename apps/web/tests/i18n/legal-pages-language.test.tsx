import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createT } from "@spiralclass/shared";

// The legal pages under D-193 and D-196. The URL picks the document: /terms
// is the English one and /es/terms the Spanish one. A language with no
// translation by a person gets the English text, with a line in its own
// language saying so, never a machine translation.

const requestHeaders = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: (name: string) => requestHeaders.get(name) ?? null }),
}));
vi.mock("@/lib/env", () => ({ hasStripeCreds: () => true }));

const { default: TermsPage } = await import("@/app/terms/page");
const { default: PrivacyNoticePage } = await import("@/app/privacy-notice/page");

async function render(page: () => Promise<React.ReactElement>, locale: "en" | "es" | "fr") {
  requestHeaders.set("x-locale", locale);
  return renderToStaticMarkup(await page());
}

beforeEach(() => requestHeaders.clear());

describe("the terms, by URL", () => {
  it("serves the English document at /terms, linking to the Spanish one by its URL", async () => {
    const html = await render(TermsPage, "en");
    expect(html).toContain('<article lang="en"');
    expect(html).toContain('href="/es/terms"');
    expect(html).not.toContain("?lang=");
  });

  it("serves the Spanish document at /es/terms, with links staying in Spanish", async () => {
    const html = await render(TermsPage, "es");
    expect(html).toContain('<article lang="es"');
    expect(html).toContain('href="/es/privacy-notice"');
    // The way back to the English text, which is the one that controls.
    expect(html).toContain('href="/terms"');
  });

  it("serves the English document at /fr/terms, and says so in French", async () => {
    const html = await render(TermsPage, "fr");
    expect(html).toContain('<article lang="en"');
    expect(html).toContain(escape(createT("fr")("web.legal.englishOnly")));
    expect(html).toContain('href="/fr/privacy-notice"');
  });

  it("does not say so where the document is in the reader's language", async () => {
    for (const locale of ["en", "es"] as const) {
      const html = await render(TermsPage, locale);
      expect(html).not.toContain(escape(createT(locale)("web.legal.englishOnly")));
    }
  });
});

describe("the privacy policy, English only", () => {
  it("says it is English only at every URL but the English one", async () => {
    expect(await render(PrivacyNoticePage, "es")).toContain(
      escape(createT("es")("web.legal.englishOnly")),
    );
    expect(await render(PrivacyNoticePage, "fr")).toContain(
      escape(createT("fr")("web.legal.englishOnly")),
    );
    expect(await render(PrivacyNoticePage, "en")).not.toContain(
      escape(createT("en")("web.legal.englishOnly")),
    );
  });
});

/** The text as renderToStaticMarkup writes it into HTML. */
function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
}
