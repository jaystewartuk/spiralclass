import { cookies, headers } from "next/headers";
import {
  DEFAULT_LOCALE,
  SYSTEM_LOCALE,
  isAppLocale,
  formatMinorUnits,
  isLocalePreference,
  localizedHref,
  matchAcceptLanguage,
  PUBLIC_FUNNEL_LOCALE,
  publicFunnelLocaleFor,
  type AppLocale,
  type LocalePreference,
} from "@spiralclass/shared";
import { createT } from "@/lib/i18n-translate";
import { LOCALE_COOKIE, URL_LOCALE_HEADER } from "@/lib/i18n-constants";

// English (en) is the default. On a public page whose URL names a language
// (D-193) that language wins. Otherwise a `locale` cookie set by the switcher
// wins over the browser's Accept-Language, so the manual choice persists. Which locales
// exist, how they match Accept-Language, and the default all come from the
// shared registry (@spiralclass/shared, packages/shared/src/i18n/locales.ts) —
// adding a language is a single edit there, not a change at every call site.

export type { AppLocale };

export { LOCALE_COOKIE, URL_LOCALE_HEADER };

// translate()/createT()/AppLocale are re-exported from i18n-translate.ts, which
// has no "next/headers" import — Client Components must import them from there
// directly (not from this file) or the build fails bundling next/headers into
// client code.
export { translate } from "@/lib/i18n-translate";

// `fallback` is what we return when neither the cookie nor Accept-Language
// resolve to a known locale. It is DEFAULT_LOCALE for every caller — the
// parameter exists only so a caller can be explicit about that — and a caller
// wanting some other language for an unmatched request is a caller deciding on
// the reader's behalf, which is the thing DEFAULT_LOCALE exists to prevent.
export async function getPreferredLocale(fallback: AppLocale = DEFAULT_LOCALE): Promise<AppLocale> {
  try {
    // A public page's URL names its language (D-193), and that wins over the
    // reader's preference: `/es/pricing` is Spanish for everyone, which is
    // what lets a search engine index it. Only the middleware sets this.
    const hdrs = await headers();
    const fromUrl = hdrs.get(URL_LOCALE_HEADER);
    if (isAppLocale(fromUrl)) {
      return fromUrl;
    }
    const cookieStore = await cookies();
    const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;
    // A concrete locale in the cookie is the user's explicit choice and wins.
    // The SYSTEM_LOCALE sentinel (or no cookie at all) means "follow the
    // browser" — so we fall through to Accept-Language, exactly as a
    // first-time visitor does. That's what makes "System Default" track the
    // browser language live instead of freezing it at selection time.
    if (isAppLocale(fromCookie)) {
      return fromCookie;
    }
    // A cookie carrying a regional tag (es-419, en-GB) reduces to its app
    // locale the same way an Accept-Language value does.
    const fromRegionalCookie = fromCookie ? matchAcceptLanguage(fromCookie) : null;
    if (fromRegionalCookie) {
      return fromRegionalCookie;
    }
    const accept = hdrs.get("accept-language");
    return matchAcceptLanguage(accept) ?? fallback;
  } catch {
    // Called outside a Next.js request scope (tests, scripts, build-time
    // static generation). Default to the caller's fallback.
    return fallback;
  }
}

/** The user's stored language *preference* — a concrete locale, or
 * SYSTEM_LOCALE ("follow the browser"). Drives the language picker's current
 * selection. Absent/invalid cookie resolves to SYSTEM_LOCALE, so a first-time
 * visitor sees "System Default" selected (the auto-detected behaviour). */
export async function getLocalePreference(): Promise<LocalePreference> {
  try {
    const cookieStore = await cookies();
    const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;
    return isLocalePreference(fromCookie) ? fromCookie : SYSTEM_LOCALE;
  } catch {
    return SYSTEM_LOCALE;
  }
}

/**
 * What the language picker shows as selected. Usually the stored preference,
 * but on a public page whose URL names a different language (D-193) — a
 * reader who prefers English, arriving at `/es/pricing` from a search — it
 * shows the language the page is actually in. Otherwise the picker would
 * already show English, and choosing English would not fire a change at all.
 */
export async function getLanguagePickerValue(): Promise<LocalePreference> {
  const preference = await getLocalePreference();
  try {
    const hdrs = await headers();
    const fromUrl = hdrs.get(URL_LOCALE_HEADER);
    if (!isAppLocale(fromUrl)) return preference;
    const followed =
      preference === SYSTEM_LOCALE
        ? (matchAcceptLanguage(hdrs.get("accept-language")) ?? DEFAULT_LOCALE)
        : preference;
    return followed === fromUrl ? preference : fromUrl;
  } catch {
    return preference;
  }
}

/** Server-side counterpart of `useFormatMoney()`: prices in the request's
 * locale's number format (D-197). */
export async function getFormatMoney(): Promise<(minorUnits: number, currency?: string) => string> {
  const locale = await getPreferredLocale();
  return (minorUnits: number, currency?: string) => formatMinorUnits(minorUnits, currency, locale);
}

/** Server-side counterpart of `useLocalizedHref()`: hrefs to public pages in
 * the request's locale (D-193). */
export async function getLocalizedHref(): Promise<(href: string) => string> {
  const locale = await getPreferredLocale();
  return (href: string) => localizedHref(href, locale);
}

/** Server-side `t(key, vars)` bound to the request's preferred locale. Use in
 * Server Components / route handlers; Client Components use `useT()` from
 * `@/components/locale-provider` instead. */
export async function getT() {
  const locale = await getPreferredLocale();
  return createT(locale);
}

/**
 * The locale the PUBLIC booking funnel (`/b/**`) always renders in,
 * regardless of the visitor's Accept-Language or locale cookie.
 *
 * Re-exported from @spiralclass/shared rather than declared here: the funnel
 * has several renderings that must agree on the pin, and a per-surface
 * constant is what let one of them follow the device language instead. The
 * rationale lives with the constant in packages/shared/src/i18n/locales.ts.
 */
export { PUBLIC_FUNNEL_LOCALE, publicFunnelLocaleFor };

/** Server-side `t()` for the `/b/**` funnel, in the TEACHER's locale (see
 * publicFunnelLocaleFor). The counterpart of getT(); the client half is the
 * nested <LocaleProvider> in b/[slug]/layout.tsx, fed from the same value.
 *
 * `teacherLocale` is required rather than optional on purpose: an omitted
 * argument would silently render one surface in the fallback language while
 * its siblings rendered hers, which is the split-language funnel this whole
 * mechanism exists to prevent. */
export function getPublicFunnelT(teacherLocale: string | null | undefined) {
  return createT(publicFunnelLocaleFor(teacherLocale));
}
