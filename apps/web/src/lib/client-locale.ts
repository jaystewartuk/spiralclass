import { DEFAULT_LOCALE, matchAcceptLanguage, type AppLocale } from "@spiralclass/shared";

// The cookie getPreferredLocale reads (LOCALE_COOKIE in lib/i18n.ts). Restated
// rather than imported: that module pulls in next/headers, which cannot be
// bundled into client code. client-locale.test.ts holds the two together.
export const CLIENT_LOCALE_COOKIE = "locale";

/**
 * The locale for a screen that has no request and no LocaleProvider to ask.
 *
 * Only global-error is in that position: it renders when the root layout
 * itself threw, so it resolves a language in the browser from what the browser
 * can see. The order is the server's (getPreferredLocale) — the reader's saved
 * choice, then the browser's language, then DEFAULT_LOCALE — and both lookups
 * go through the locale registry.
 *
 * It used to list `en|es|fr` by hand, twice. A new language would have had to
 * remember both, on the screen least likely to be looked at when one is added.
 *
 * Pure, with both inputs passed in, so it can be tested without a document.
 */
export function detectClientLocale(
  cookieHeader: string | null | undefined,
  browserLanguage: string | null | undefined,
): AppLocale {
  // A saved "system" (follow the browser) matches no locale and falls through,
  // exactly as it does on the server.
  return (
    matchAcceptLanguage(readCookie(cookieHeader, CLIENT_LOCALE_COOKIE)) ??
    matchAcceptLanguage(browserLanguage) ??
    DEFAULT_LOCALE
  );
}

function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return null;
    }
  }
  return null;
}
