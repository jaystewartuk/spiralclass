import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CANCELLATION_POLICY_ANCHOR,
  LEGACY_CANCELLATION_ANCHOR,
  cancellationPolicyPath,
} from "@/lib/terms-anchors";

/**
 * The cancellation-policy deep links land on the clause, in every language.
 *
 * A URL fragment never reaches the server, so a link pointing at an id the
 * page does not carry fails in the only way that cannot be detected from
 * outside: the request 200s, the browser scrolls to the top of a long legal
 * document, and the reader is left to find the clause. Nothing that checks
 * status codes — the link checker, the E2E suite, an uptime probe — sees it.
 *
 * So both ends are pinned here: the ids the rendered page carries, and the ids
 * the links point at. The page renders every document through one function
 * (the documents are data, D-196), so it is checked rendered, per language.
 */

const urlLocale = vi.hoisted(() => ({ value: "en" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: (n: string) => (n === "x-locale" ? urlLocale.value : null) }),
}));
vi.mock("@/lib/env", () => ({ hasStripeCreds: () => true }));

const TERMS_SOURCE = readFileSync(resolve(__dirname, "../../src/app/terms/page.tsx"), "utf8");

async function renderedTerms(locale: "en" | "es" | "fr"): Promise<string> {
  urlLocale.value = locale;
  const { default: TermsPage } = await import("@/app/terms/page");
  return renderToStaticMarkup(await TermsPage());
}

const count = (html: string, id: string) => html.split(`id="${id}"`).length - 1;

describe("/terms cancellation anchor", () => {
  it.each(["en", "es", "fr"] as const)(
    "is carried exactly once by the document a %s reader gets",
    async (locale) => {
      const html = await renderedTerms(locale);
      expect(count(html, CANCELLATION_POLICY_ANCHOR)).toBe(1);
    },
  );

  // Cancellation and deduction emails carry the earlier id and are already
  // delivered, so it is not a link anybody can go and fix.
  it.each(["en", "es"] as const)(
    "keeps the earlier id reachable for a %s reader",
    async (locale) => {
      const html = await renderedTerms(locale);
      expect(count(html, LEGACY_CANCELLATION_ANCHOR)).toBe(1);
      expect(LEGACY_CANCELLATION_ANCHOR).toBe("cancelaciones");
    },
  );

  it("renders the ids as constants, not as repeated string literals", () => {
    // The failure this guards is drift between the page and the links, which
    // only stays impossible while both read the same constant.
    expect(TERMS_SOURCE).not.toContain(`id="${CANCELLATION_POLICY_ANCHOR}"`);
    expect(TERMS_SOURCE).not.toContain(`id="${LEGACY_CANCELLATION_ANCHOR}"`);
  });

  // Each reader's own language's URL (D-193). The bare URL is the English
  // document; French has no translated terms, and its URL says so in French
  // around the English text (D-196).
  it("builds a path, at the reader's language's URL, whose fragment the page carries", () => {
    expect(cancellationPolicyPath("en")).toBe(`/terms#${CANCELLATION_POLICY_ANCHOR}`);
    expect(cancellationPolicyPath("es")).toBe(`/es/terms#${CANCELLATION_POLICY_ANCHOR}`);
    expect(cancellationPolicyPath("fr")).toBe(`/fr/terms#${CANCELLATION_POLICY_ANCHOR}`);
  });

  it("points every link at the current id, not the one kept for old email", () => {
    for (const locale of ["en", "es", "fr"] as const) {
      expect(cancellationPolicyPath(locale)).not.toContain(LEGACY_CANCELLATION_ANCHOR);
    }
  });
});
