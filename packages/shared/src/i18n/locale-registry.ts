// The locale registry's rows — the ONE place a supported language is declared.
// Everything that
// used to hard-code the `"es" | "en"` pair derives from this list, so adding
// a language (e.g. fr, pt-BR, en-GB) is ADDITIVE: append one row here, drop in
// its catalog block, and the compiler points you at the finite set of places
// that need the new entry instead of silently shipping a half-translated locale.
//
// Adding a language:
//   1. Append a row to LOCALES below, with `launched: false`.
//   2. Add the matching per-locale block to ./catalog.ts (the completeness
//      guard there fails the build until every key is translated).
//   3. Once a native speaker has read it (D-81) and its terms and privacy
//      policy exist as person-made translations (D-196), flip `launched`.
// No other code changes: the language picker, Accept-Language matching, the
// URL prefixes and hreflang, the outbound-copy bridge, and the persisted
// preference all read this registry.
//
// Conventions:
//   * `tag`          — BCP-47 language tag (hyphenated). This is the canonical
//                      identifier used everywhere in-app, in the `locale`
//                      cookie, on <html lang>, and on Teacher.locale /
//                      Student.locale.
//   * `languageCode` — the code the outbound email/push templates branch on.
//                      Kept as a per-locale field so the locale→code bridge has
//                      a single source of truth instead of a parallel mapping.
//   * `label`        — the language's own endonym (native name), shown in the
//                      language picker.
//   * `englishName`  — the language's English display name, for surfaces that
//                      list languages in English (docs, admin).
//   * `match`        — matches an Accept-Language header / device languageTag
//                      prefix for this locale.
//   * `intl`         — the BCP-47 tag handed to `Intl` and `toLocale*`. The
//                      `tag` names a catalog; this names a set of CLDR
//                      conventions for numbers, currency symbols and clocks,
//                      and the two differ whenever a language's root
//                      conventions are not its readers' (see `intlLocale`).
//   * `og`           — the Open Graph locale. Open Graph wants a
//                      region-qualified, underscore-separated tag (`en_US`,
//                      never bare `en`), so it cannot be derived from `tag`.
//   * `dir`          — the writing direction, set on <html dir>.
//   * `launched`     — whether readers are offered it (see the field).
//
// The last three used to be dictionaries kept beside their one consumer —
// `INTL_LOCALE` here, `OG_LOCALE` in the root layout — which made "append one
// row" untrue: a new language also had to be added to each of them, and only
// the ones typed `Record<AppLocale, …>` said so. A fact that is one value per
// language belongs on the language's row, where it cannot be forgotten.

export type LocaleDefinition = {
  tag: string;
  languageCode: string;
  label: string;
  englishName: string;
  match: RegExp;
  intl: string;
  og: string;
  dir: "ltr" | "rtl";
  /**
   * How a booking funnel in this language shows the price in the SELLER'S own
   * currency (formatPriceForBuyer). "narrow" is the bare glyph — "$1,500.00" —
   * for a language whose funnel readers are the seller's own market, where
   * the alternative is a code ("MXN 1,500.00" under es-419). "symbol" keeps
   * the disambiguated form — "MX$", "$MX" — for a language whose readers are
   * cross-border. Every language must choose; nothing infers it.
   */
  ownCurrencySymbol: "narrow" | "symbol";
  /**
   * Whether readers are offered this language. An unlaunched locale is fully
   * typed and its catalog complete, but it is out of the language picker,
   * browser detection, the teacher's buyer-language choice, URL prefixes,
   * redirects and hreflang — so a half-reviewed language reaches nobody who
   * did not go looking for it, and is never advertised to a search engine
   * (D-193). Stored values still resolve, so a reviewer can read it.
   */
  launched: boolean;
};

export const LOCALES = [
  {
    tag: "es",
    languageCode: "es",
    label: "Español",
    englishName: "Spanish",
    match: /^es\b/i,
    // Latin American conventions ("1,500.00", "5:00 p.m."), not CLDR's root
    // `es` ("1500,00", "17:00").
    intl: "es-419",
    og: "es_LA",
    dir: "ltr",
    // A Spanish funnel's readers are the teacher's own market, and es-419's
    // non-narrow form is a bare code.
    ownCurrencySymbol: "narrow",
    launched: true,
  },
  {
    tag: "en",
    languageCode: "en",
    label: "English",
    englishName: "English",
    match: /^en\b/i,
    intl: "en",
    og: "en_US",
    dir: "ltr",
    // English is the cross-border audience: "$6,400.00" reads as US dollars.
    ownCurrencySymbol: "symbol",
    launched: true,
  },
  {
    tag: "fr",
    languageCode: "fr",
    label: "Français",
    englishName: "French",
    match: /^fr\b/i,
    intl: "fr",
    og: "fr_FR",
    dir: "ltr",
    // French already has a symbol of its own for each dollar ("$MX", "$CO").
    // It was given the bare "$", which a French reader takes for any dollar.
    ownCurrencySymbol: "symbol",
    launched: true,
  },
] as const satisfies readonly LocaleDefinition[];
