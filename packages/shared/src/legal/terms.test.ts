import { describe, expect, it } from "vitest";
import {
  ENGLISH_TERMS,
  SPANISH_TERMS,
  TERMS_VERSION,
  chooseTermsDocument,
  termsDocumentFor,
  termsLanguages,
  type TermsDocument,
} from "./terms";

// The Terms of Service as data (D-196): the English text applies, the Spanish
// one is a translation of a recorded English version, and a translation that
// falls behind is not served as the terms.

describe("which document a reader gets", () => {
  it("serves Spanish to a Spanish reader and English to everyone else", () => {
    expect(termsDocumentFor("es").document).toBe(SPANISH_TERMS);
    for (const locale of ["en", "fr", "de"]) {
      expect(termsDocumentFor(locale)).toEqual({
        document: ENGLISH_TERMS,
        translationOutdated: false,
      });
    }
  });

  it("serves the current English, saying so, once the translation is behind", () => {
    const newerEnglish: TermsDocument = { ...ENGLISH_TERMS, version: "2099-01-01" };
    expect(chooseTermsDocument("es", newerEnglish, { es: SPANISH_TERMS })).toEqual({
      document: newerEnglish,
      translationOutdated: true,
    });
  });

  it("advertises Spanish only while the translation is current", () => {
    expect(termsLanguages()).toEqual(["en", "es"]);
  });
});

describe("the documents", () => {
  it("records the English version, and which one the translation translates", () => {
    expect(ENGLISH_TERMS.version).toBe(TERMS_VERSION);
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(SPANISH_TERMS.translates).toBe(TERMS_VERSION);
  });

  // A translation says the same things in the same places. The same sections,
  // the cancellation clause in the same one, and the same links and
  // conditional runs in the same paragraphs — so a clause cannot go missing
  // from one language unnoticed.
  it("is the same shape in both languages", () => {
    const shape = (d: TermsDocument) =>
      d.sections.map((s) => ({
        anchor: s.anchor ?? null,
        paragraphs: s.paragraphs.map((p) =>
          p.filter((run) => typeof run !== "string").map((run) => (run as { kind: string }).kind),
        ),
      }));
    expect(shape(SPANISH_TERMS)).toEqual(shape(ENGLISH_TERMS));
    expect(ENGLISH_TERMS.sections.filter((s) => s.anchor === "cancellationPolicy")).toHaveLength(1);
  });

  it("links each document to the other", () => {
    expect(ENGLISH_TERMS.switchTo.locale).toBe("es");
    expect(SPANISH_TERMS.switchTo.locale).toBe("en");
  });
});
