import { describe, expect, it } from "vitest";
import { CONTENT_DOCS, listContentDocs, listPublicFaqDocs } from "@spiralclass/shared";
import { anchorLinkResolver, prepareHelpGuides } from "@/lib/help/guides";
import { buildHelpSearchEntries } from "@/lib/help/search";
import { collectHelpFaq } from "@/lib/help/faq";

// Guards on the REAL help content, not a fixture — the bugs these catch were
// all in the interaction between docs/help's authoring conventions and what
// the app does with them, which a hand-written fixture cannot reproduce.

const LOCALES = ["en", "es-MX"] as const;

// `[text](other-doc.md)` is how docs/help cross-references itself, and it is
// meaningless in a browser: it resolves against the current route and 404s.
// One such link was live on the public /help page. Every surface must resolve
// or unwrap them.
const RELATIVE_MD_LINK = /\]\((?!\w+:)(?!\/)[^)]*\.md\)/;

describe("help content, as the app renders it", () => {
  it("has public FAQ docs to render at all", () => {
    expect(listPublicFaqDocs().length).toBeGreaterThan(0);
  });

  for (const locale of LOCALES) {
    it(`leaves no dead relative .md link on the public page (${locale})`, () => {
      const docs = listPublicFaqDocs();
      const guides = prepareHelpGuides(docs, locale, anchorLinkResolver(docs));
      const offenders = guides.flatMap((guide) =>
        guide.sections
          .filter((section) => RELATIVE_MD_LINK.test(section.body))
          .map((section) => `${guide.slug} → ${section.heading}`),
      );
      expect(offenders).toEqual([]);
    });

    it(`leaves no dead relative .md link on a gated article (${locale})`, () => {
      const offenders: string[] = [];
      for (const audience of ["teacher", "student"] as const) {
        const siblings = new Set(listContentDocs(audience).map((d) => d.slug));
        for (const doc of listContentDocs(audience)) {
          const [guide] = prepareHelpGuides([doc], locale, (slug) =>
            siblings.has(slug) ? `/help/${audience}/${slug}` : null,
          );
          for (const section of guide.sections) {
            if (RELATIVE_MD_LINK.test(section.body)) {
              offenders.push(`${audience}/${doc.slug} → ${section.heading}`);
            }
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it(`gives every section on the public page a unique anchor (${locale})`, () => {
      const docs = listPublicFaqDocs();
      const guides = prepareHelpGuides(docs, locale, anchorLinkResolver(docs));
      const ids = guides.flatMap((guide) => [
        guide.id,
        ...guide.sections.map((section) => section.id),
      ]);
      expect(ids.length).toBe(new Set(ids).size);
    });

    it(`only ever indexes anchors the page actually renders (${locale})`, () => {
      const docs = listPublicFaqDocs();
      const guides = prepareHelpGuides(docs, locale, anchorLinkResolver(docs));
      const rendered = new Set(
        guides.flatMap((guide) => [guide.id, ...guide.sections.map((s) => s.id)]),
      );
      const dangling = buildHelpSearchEntries(guides)
        .filter((entry) => !rendered.has(entry.id))
        .map((entry) => `${entry.label} → #${entry.id}`);
      expect(dangling).toEqual([]);
    });

    it(`does not print the guide summary twice in a row (${locale})`, () => {
      const docs = listPublicFaqDocs();
      for (const guide of prepareHelpGuides(docs, locale, anchorLinkResolver(docs))) {
        expect(guide.sections[0]?.body.trim()).not.toBe(guide.summary.trim());
      }
    });
  }

  it("finds real questions for the FAQ structured data", () => {
    const docs = listPublicFaqDocs();
    const faq = collectHelpFaq(prepareHelpGuides(docs, "en", anchorLinkResolver(docs)));
    expect(faq.length).toBeGreaterThan(3);
    // Every entry must genuinely be a question — this markup is a claim about
    // the page, and a heading dressed as one is a false claim.
    for (const item of faq) {
      expect(item.question.endsWith("?")).toBe(true);
      expect(item.answer.length).toBeGreaterThan(0);
    }
  });

  it("indexes something from every public guide, so search can reach all of them", () => {
    const docs = listPublicFaqDocs();
    const guides = prepareHelpGuides(docs, "en", anchorLinkResolver(docs));
    const entries = buildHelpSearchEntries(guides);
    for (const guide of guides) {
      expect(entries.some((entry) => entry.id === guide.id)).toBe(true);
    }
    expect(entries.length).toBeGreaterThan(guides.length);
  });

  it("splits every doc in the registry into at least one anchored section", () => {
    for (const doc of CONTENT_DOCS) {
      const [guide] = prepareHelpGuides([doc], "en", () => null);
      expect(guide.sections.length, `${doc.audience}/${doc.slug} has no sections`).toBeGreaterThan(
        0,
      );
    }
  });
});
