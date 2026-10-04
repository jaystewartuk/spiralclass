// Names shared by the middleware and the request-scoped i18n helpers. They live
// apart from lib/i18n.ts because that file imports next/headers and the string
// catalog, and the middleware needs neither.

/** The reader's explicit language choice, written only by the switcher. */
export const LOCALE_COOKIE = "locale";

/**
 * The language a public page's URL names (D-193), set by the middleware on a
 * localized public path and read first by getPreferredLocale. The middleware
 * deletes any value a client sends, so only it can set this.
 */
export const URL_LOCALE_HEADER = "x-locale";
