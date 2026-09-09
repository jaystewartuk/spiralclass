import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import ts from "typescript";

import { strings, PUBLIC_FUNNEL_LOCALE, publicFunnelLocaleFor } from "@spiralclass/shared";
import { getPublicFunnelT } from "@/lib/i18n";

// The layout resolves the teacher's locale from her slug; the DB lookup is not
// what these tests are about.
const funnelLocaleForSlug = vi.fn(async () => "es-MX" as const);
vi.mock("@/lib/booking/funnel-locale", () => ({ funnelLocaleForSlug }));

// The app/b/** layout renders JSX with the classic runtime under this config.
(globalThis as Record<string, unknown>).React = React;

// The public booking funnel (/b/**) is the surface a teacher shares on
// WhatsApp and Facebook, and every surface of it must render in ONE language:
// the one SHE CHOSE for her booking page (`teachers.booking_page_locale`,
// resolved by publicFunnelLocaleFor).
//
// It was a hardcoded English until 2026-08-25 ("students are English
// learners"), then briefly derived from her own `locale` — and the platform's
// first teacher is the counterexample to that: her UI is Spanish and she
// teaches Spanish TO English speakers, so her buyers read English while she
// reads Spanish. What her buyers read is its own fact and so it is her own
// setting. What has not changed, and is what these tests actually guard, is
// that all four renderings agree on whatever it is.
//
// The regression these tests exist for: the per-teacher social card
// (b/[slug]/opengraph-image.tsx) hardcoded its tagline as the es-MX catalog's
// value verbatim, so a booking link shared to Facebook rendered a SPANISH card
// above an ENGLISH landing page. Nothing caught it, because a hardcoded string
// is invisible to both the pinned translator and the i18n guard's JSX rule.

const FUNNEL_DIR = path.join(__dirname, "../../src/app/b");

function funnelSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return funnelSourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Every piece of text a file could actually RENDER: string literals, template
 * chunks, and raw JSX text. Parsed rather than grepped so that prose in a
 * comment — which renders nothing — can't trip the guard. (It did: the Wise
 * page's header comment quotes the Spanish label it no longer hardcodes.) */
function renderableText(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      out.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("public booking funnel renders in one language", () => {
  it("renders in her chosen booking-page locale, not the visitor's and not a fixed English", () => {
    // The server translator takes that one value and nothing else — no ambient
    // request locale can reach it.
    expect(getPublicFunnelT("es-MX")("web.bookingLanding.tagline")).toBe(
      strings["es-MX"]["web.bookingLanding.tagline"],
    );
    expect(getPublicFunnelT("fr")("web.bookingLanding.tagline")).toBe(
      strings.fr["web.bookingLanding.tagline"],
    );
  });

  it("falls back for a teacher who has not chosen one", () => {
    expect(PUBLIC_FUNNEL_LOCALE).toBe("en");
    for (const missing of [null, undefined, "", "zz-ZZ"]) {
      expect(publicFunnelLocaleFor(missing)).toBe(PUBLIC_FUNNEL_LOCALE);
    }
    expect(getPublicFunnelT(null)("web.bookingLanding.tagline")).toBe(
      strings.en["web.bookingLanding.tagline"],
    );
  });

  // The regression this pins is the reason the field exists: deriving the
  // funnel's language from the teacher's OWN locale looked reasonable and was
  // wrong for the platform's first teacher, whose UI is Spanish and whose
  // buyers read English. The two must be independently settable.
  it("is independent of the teacher's own UI locale", () => {
    // es-MX dashboard, English booking page — Alicia Moreno's actual case.
    expect(publicFunnelLocaleFor("en")).toBe("en");
    // ...and the reverse, for a teacher whose buyers do share her language.
    expect(publicFunnelLocaleFor("es-MX")).toBe("es-MX");
  });

  it("declares the funnel's real language with lang=, matching what it renders", async () => {
    // The root layout sets <html lang> from the REQUEST locale, which a nested
    // layout can't reach — so a Spanish browser got lang="es-MX" wrapped around
    // an all-English page. That's the signal Chrome's translate prompt and
    // screen-reader pronunciation key off, i.e. the one path by which the
    // funnel could be shown in a language its author didn't choose. The
    // declared language must therefore track the TEACHER's, not the visitor's
    // and not a constant.
    const { default: PublicFunnelLayout } = await import("@/app/b/[slug]/layout");
    const render = async (locale: "es-MX" | "en") => {
      funnelLocaleForSlug.mockResolvedValueOnce(locale as "es-MX");
      const element = await PublicFunnelLayout({
        children: React.createElement("p", null, "Book, pay and get reminders"),
        params: Promise.resolve({ slug: "mira" }),
      });
      return renderToStaticMarkup(element);
    };
    expect(await render("es-MX")).toContain('lang="es-MX"');
    const english = await render("en");
    expect(english).toContain('lang="en"');
    expect(english).not.toContain('lang="es-MX"');
  });

  it("keeps the card's static alt on the fallback locale", async () => {
    // `alt` is a static module export — Next evaluates it with no request, so
    // there is no teacher to read a locale from and it cannot be per-teacher.
    // The card BODY is (see the handler); this is alt text for scrapers and
    // assistive tech, the one string here where a fallback costs nothing.
    const card = await import("@/app/b/[slug]/opengraph-image");
    expect(card.alt).toBe(strings[PUBLIC_FUNNEL_LOCALE]["web.bookingCard.alt"]);
  });

  it("keeps TEACHER-acquisition copy off the student-facing share card", () => {
    // The card previews a STUDENT's booking link. Its generic heading (shown
    // when the slug resolves to no publicly-listed teacher) once read "Teach.
    // We handle the rest." — the teacher-acquisition line from the marketing
    // landing page, aimed at the wrong audience entirely. The two headlines
    // must stay distinct, and the card's must match how its own alt text has
    // always described the image.
    expect(strings.en["web.bookingCard.genericHeading"]).not.toBe(
      strings.en["web.landing.headline"],
    );
    expect(strings.en["web.bookingCard.genericHeading"].toLowerCase()).toContain(
      "book your classes",
    );
    expect(strings.en["web.bookingCard.alt"].toLowerCase()).toContain("book your classes");

    // ...and the card must not reach for the landing headline again.
    const cardSource = readFileSync(path.join(FUNNEL_DIR, "[slug]/opengraph-image.tsx"), "utf8");
    const referenced = renderableText(path.join(FUNNEL_DIR, "[slug]/opengraph-image.tsx"));
    expect(referenced).not.toContain("web.landing.headline");
    expect(cardSource).toContain("web.bookingCard.genericHeading");
  });

  it("renders no verbatim Spanish catalog copy anywhere under /b/**", () => {
    // The generalized guard, and it outlives the English pin: any es-MX
    // catalog value typed into funnel source is copy that escaped the
    // translator, so it renders Spanish at an English teacher's buyer too.
    // This is precisely how the OG card drifted. Short values are skipped because
    // plenty of them are legitimately identical across locales ("Stripe",
    // "Wise", "OK"); anything long enough to be a sentence is not a
    // coincidence.
    const spanishOnly = Object.entries(strings["es-MX"]).filter(
      ([key, value]) => value.length >= 15 && value !== strings.en[key as keyof typeof strings.en],
    );
    expect(spanishOnly.length).toBeGreaterThan(100); // the guard has real material

    const offenders: string[] = [];
    for (const file of funnelSourceFiles(FUNNEL_DIR)) {
      const texts = renderableText(file);
      for (const [key, value] of spanishOnly) {
        if (texts.some((text) => text.includes(value))) {
          offenders.push(`${path.relative(FUNNEL_DIR, file)} hardcodes es-MX copy for "${key}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
