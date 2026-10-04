import { describe, expect, it } from "vitest";
import { LOCALES, LOCALIZED_PUBLIC_PATHS } from "@spiralclass/shared";
import { localizedAlternates, pageLanguages } from "./localized-alternates";

// D-193: every URL of a public page carries the same hreflang set, with
// x-default on the bare URL, and a page is advertised only in the languages
// its content exists in.

describe("localizedAlternates", () => {
  it("gives a page in every language a self-canonical on each of its URLs", () => {
    expect(localizedAlternates("/pricing", "fr")).toEqual({
      canonical: "/fr/pricing",
      languages: { en: "/pricing", es: "/es/pricing", fr: "/fr/pricing", "x-default": "/pricing" },
    });
    expect(localizedAlternates("/", "es")?.canonical).toBe("/es");
  });

  it("is reciprocal: the same set on every URL of every public page", () => {
    for (const path of LOCALIZED_PUBLIC_PATHS) {
      const sets = LOCALES.map((l) => JSON.stringify(localizedAlternates(path, l.tag)?.languages));
      expect(new Set(sets).size, path).toBe(1);
    }
  });

  it("lists every language the content exists in, and each one's canonical is itself", () => {
    for (const path of LOCALIZED_PUBLIC_PATHS) {
      const languages = pageLanguages(path);
      for (const locale of languages) {
        const alternates = localizedAlternates(path, locale)!;
        expect(alternates.canonical, `${path} ${locale}`).toBe(
          (alternates.languages as Record<string, string>)[locale],
        );
      }
    }
  });

  // Legal text is translated by a person or not at all (D-196). Listing
  // /fr/terms as the French terms would point French searchers at an English
  // contract.
  it("advertises the legal documents only in the languages they are written in", () => {
    expect(pageLanguages("/terms")).toEqual(["en", "es"]);
    expect(pageLanguages("/privacy-notice")).toEqual(["en"]);
    expect(localizedAlternates("/terms", "fr")).toEqual({
      canonical: "/terms",
      languages: { en: "/terms", es: "/es/terms", "x-default": "/terms" },
    });
    expect(localizedAlternates("/privacy-notice", "es")?.canonical).toBe("/privacy-notice");
  });
});
