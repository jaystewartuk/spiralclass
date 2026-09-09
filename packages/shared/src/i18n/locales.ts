// The locale registry — the ONE place a supported language is declared.
// Everything that
// used to hard-code the `"es-MX" | "en"` pair derives from this list, so adding
// a language (e.g. fr, pt-BR, en-GB) is ADDITIVE: append one row here, drop in
// its catalog block, and the compiler points you at the finite set of places
// that need the new entry instead of silently shipping a half-translated locale.
//
// Adding a language is exactly two steps:
//   1. Append a row to LOCALES below.
//   2. Add the matching per-locale block to ./catalog.ts (the completeness
//      guard there fails the build until every key is translated).
// No other code changes: the language picker, Accept-Language matching, the
// device-locale detection, the outbound-copy bridge, and the persisted
// preference all read this registry.
//
// Conventions:
//   * `tag`          — BCP-47 language tag (hyphenated). This is the canonical
//                      identifier used everywhere in-app, in the `locale`
//                      cookie, on <html lang>, and on Teacher.locale /
//                      Student.locale.
//   * `languageCode` — the underscore form used by the outbound email/push
//                      templates (a historical vendor-flavoured spelling). Kept
//                      as a per-locale field so the hyphen/underscore bridge has
//                      a single source of truth instead of a parallel mapping.
//   * `label`        — the language's own endonym (native name), shown in the
//                      language picker.
//   * `englishName`  — the language's English display name, for surfaces that
//                      list languages in English (docs, admin).
//   * `match`        — matches an Accept-Language header / device languageTag
//                      prefix for this locale.

export type LocaleDefinition = {
  tag: string;
  languageCode: string;
  label: string;
  englishName: string;
  match: RegExp;
};

export const LOCALES = [
  {
    tag: "es-MX",
    languageCode: "es_MX",
    label: "Español",
    englishName: "Spanish",
    match: /^es\b/i,
  },
  { tag: "en", languageCode: "en", label: "English", englishName: "English", match: /^en\b/i },
  { tag: "fr", languageCode: "fr", label: "Français", englishName: "French", match: /^fr\b/i },
] as const satisfies readonly LocaleDefinition[];

// The canonical in-app locale identifier (BCP-47). Widening the registry above
// widens this union automatically — that is the whole point.
export type AppLocale = (typeof LOCALES)[number]["tag"];

// The outbound-copy language identifier (underscore form) for email/push.
export type LanguageCode = (typeof LOCALES)[number]["languageCode"];

export const LANGUAGE_CODES = LOCALES.map((l) => l.languageCode) as LanguageCode[];

// Platform default / fallback. Matches the web default and the DB column
// default (Teacher.locale / Student.locale default to "en"); another locale is
// chosen when the request/device signals it (see matchAcceptLanguage / mobile
// detect) or when the user picks one explicitly.
export const DEFAULT_LOCALE: AppLocale = "en";

const LOCALE_TAGS = LOCALES.map((l) => l.tag) as AppLocale[];

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (LOCALE_TAGS as string[]).includes(value);
}

/** Resolve an Accept-Language header (or a device's BCP-47 languageTag) to a
 * supported locale, or null when none of the registered locales match (the
 * caller then falls back to its default). */
export function matchAcceptLanguage(header: string | null | undefined): AppLocale | null {
  const value = (header ?? "").trim();
  if (!value) return null;
  for (const locale of LOCALES) {
    if (locale.match.test(value)) return locale.tag;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Language preference (manual selection + "System Default")
// ---------------------------------------------------------------------------

// The sentinel a user's stored preference holds to mean "always follow the
// device / browser language" rather than pinning a specific locale. Kept
// distinct from any AppLocale so "System Default" survives a device-language
// change (it re-resolves live) instead of being frozen at selection time.
export const SYSTEM_LOCALE = "system";

/** What the user's language choice is persisted as: either an explicit locale,
 * or the SYSTEM sentinel meaning "follow the device". */
export type LocalePreference = typeof SYSTEM_LOCALE | AppLocale;

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === SYSTEM_LOCALE || isAppLocale(value);
}

/** Resolve a stored preference against the auto-detected device/browser locale
 * into the concrete locale to render. An explicit locale wins; the SYSTEM
 * sentinel (or any unrecognized value) follows the detected locale, so
 * "System Default" tracks the device live rather than a frozen snapshot. */
export function resolveLocale(
  preference: LocalePreference | null | undefined,
  detected: AppLocale,
): AppLocale {
  return isAppLocale(preference) ? preference : detected;
}

export type LocaleOption = {
  /** The value to persist: a locale tag, or the SYSTEM sentinel. */
  value: LocalePreference;
  /** The label to render. Locale rows use the language's own endonym; the
   * System row's label is supplied by the caller (localized via the catalog). */
  label: string;
};

/** Build the language-picker option list straight from the registry: a leading
 * "System Default" row (whose label the caller localizes) followed by one row
 * per registered locale, in registry order. Registering a new locale adds its
 * row here automatically — the picker never hardcodes a language. (Named
 * `localeOptions`, distinct from `languageOptions` in ./languages.ts, which
 * lists the *teaching* languages a class can be taught in — a different axis.) */
export function localeOptions(systemDefaultLabel: string): LocaleOption[] {
  return [
    { value: SYSTEM_LOCALE, label: systemDefaultLabel },
    ...LOCALES.map((l) => ({ value: l.tag, label: l.label })),
  ];
}

/** Bridge an AppLocale (or any locale-ish string, e.g. a DB value) to the
 * underscore `languageCode` the email/push templates branch on. Unknown input
 * resolves to Spanish's code, preserving the historical outbound default. */
export function localeToLanguageCode(locale: string | null | undefined): LanguageCode {
  const normalized = (locale ?? "").toLowerCase();
  const hit = LOCALES.find((l) => normalized === l.tag.toLowerCase() || l.match.test(normalized));
  return (hit ?? LOCALES[0]).languageCode;
}

/** The reverse bridge: an outbound `languageCode` (e.g. a persisted
 * `Notification.languageCode` row) back to its BCP-47 `AppLocale` tag, for
 * surfaces that display notification history. Unknown input falls back to
 * `DEFAULT_LOCALE`, not the first registry entry — this direction has no
 * historical outbound-default precedent to preserve. */
export function languageCodeToLocale(languageCode: string | null | undefined): AppLocale {
  const hit = LOCALES.find((l) => l.languageCode === languageCode);
  return hit?.tag ?? DEFAULT_LOCALE;
}

// ---------------------------------------------------------------------------
// The public booking funnel's pinned locale
// ---------------------------------------------------------------------------

/**
 * The fallback locale for the PUBLIC booking funnel (`/b/**`) — used when the
 * teacher whose page is being rendered has no resolvable locale of her own.
 *
 * **The funnel renders in the TEACHER's locale, not the visitor's** — see
 * `publicFunnelLocaleFor` below. Two properties have to hold at once, and this
 * is the only rule that gives both:
 *
 *   1. **One language for the whole funnel.** Every surface must agree, or the
 *      landing page renders in one language and the payment form in another —
 *      the split-language funnel the original pin was introduced to end. A
 *      per-visitor rule cannot give this, because the social share card is
 *      generated with no visitor to negotiate with.
 *   2. **A language her buyers can actually read.** Until 2026-08-25 the pin
 *      was a hardcoded English, justified by "students are English learners".
 *      That was true of the first teachers and is not true of the product.
 *      It was then briefly derived from her own `locale`, on the theory that
 *      she shares her link into her own language's network — and the
 *      platform's first teacher is the counterexample: her UI is Spanish and
 *      she teaches Spanish TO English speakers, so her buyers read English
 *      while she reads Spanish. What her buyers read is its own fact, so it
 *      is its own field: `teachers.booking_page_locale`, which she sets.
 *
 * It lives in the shared package because the funnel has THREE renderings that
 * must agree, and they used to be pinned (or not) one at a time:
 *   * the web pages          — apps/web/src/lib/i18n.ts (getPublicFunnelT)
 *   * the web Client half    — apps/web/src/app/b/[slug]/layout.tsx
 *   * the social share card  — apps/web/src/app/b/[slug]/opengraph-image.tsx
 * All three now derive from the same teacher value through the one function
 * below; a per-surface constant left one of them following the DEVICE
 * language, which is exactly the drift the pin exists to prevent.
 *
 * Applies to `/b/**` only. Everything else — the teacher dashboard, the
 * student portal, marketing — keeps following the viewer's preference.
 */
export const PUBLIC_FUNNEL_LOCALE: AppLocale = "en";

/**
 * The locale to render a teacher's public funnel in.
 *
 * Pass `teachers.booking_page_locale` — the language SHE chose for her booking
 * page. NULL (she hasn't chosen), an unrecognised tag, or a client too old to
 * send the field all fall back to `PUBLIC_FUNNEL_LOCALE`, which is what every
 * funnel rendered before the field existed.
 *
 * Do NOT pass her `locale` (her own UI language) — those are different facts
 * and the platform's first teacher has them diverge. And never the visitor's:
 * see the note above on why the funnel is pinned per teacher rather than
 * negotiated per request.
 */
export function publicFunnelLocaleFor(bookingPageLocale: string | null | undefined): AppLocale {
  return isAppLocale(bookingPageLocale) ? bookingPageLocale : PUBLIC_FUNNEL_LOCALE;
}
