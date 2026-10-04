import type { Metadata } from "next";
import {
  DEFAULT_LOCALE,
  LOCALES,
  localizedPath,
  termsLanguages,
  type AppLocale,
} from "@spiralclass/shared";

// The canonical URL and the hreflang set for a localized public page (D-193).
//
// A page is advertised only in the languages its content exists in. The
// chrome around a page is translated everywhere, but a search engine indexes
// the content, and listing `/fr/terms` as the French terms would point French
// searchers at an English contract. So a document authored in fewer languages
// says so here, and its other URLs canonicalise to the default one.

const DOCUMENT_LANGUAGES: Readonly<Record<string, readonly AppLocale[]>> = {
  // English, plus each translation that is current (D-196): a translation
  // behind the English is not advertised as the terms.
  "/terms": termsLanguages(),
  // English only (D-128).
  "/privacy-notice": ["en"],
};

/** The languages a public page's content exists in. */
export function pageLanguages(path: string): readonly AppLocale[] {
  return DOCUMENT_LANGUAGES[path] ?? LOCALES.map((l) => l.tag);
}

/**
 * `alternates` for a localized public page rendered in `locale`. The
 * canonical is the page's own URL when its content exists in `locale`, and the
 * default URL otherwise. `languages` lists every language the content exists
 * in, plus `x-default` (the bare URL), and is the same set on every one of the
 * page's URLs, so the annotations are reciprocal.
 */
export function localizedAlternates(path: string, locale: AppLocale): Metadata["alternates"] {
  const languages = pageLanguages(path);
  const canonicalLocale = languages.includes(locale) ? locale : DEFAULT_LOCALE;
  return {
    canonical: localizedPath(path, canonicalLocale),
    languages: {
      ...Object.fromEntries(languages.map((l) => [l, localizedPath(path, l)])),
      "x-default": path,
    },
  };
}
