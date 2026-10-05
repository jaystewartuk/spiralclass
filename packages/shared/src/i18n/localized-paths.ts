import {
  DEFAULT_LOCALE,
  LAUNCHED_LOCALES,
  SYSTEM_LOCALE,
  isAppLocale,
  isLaunchedLocale,
  matchAcceptLanguage,
  type AppLocale,
} from "./locales";

// One URL per language for the public pages (D-193). A page in a locale other
// than DEFAULT_LOCALE lives under that locale's tag, lower-cased (`/es/pricing`,
// `/fr/help/…`); the bare URL is DEFAULT_LOCALE. The URL decides the language
// of a page it names, and nothing else does — a search engine indexes one
// language per URL, and its crawler sends no cookie and no Accept-Language.
//
// This file imports only `./locales`, so the middleware can take it through
// the `@spiralclass/shared/localized-paths` subpath without bundling the
// string catalog.

/**
 * The public pages that have a URL per language. Every other path — the
 * signed-in app, the student portal, admin, the API and the booking funnel —
 * is never prefixed: the app follows the person's own setting, and `/b/**`
 * follows the teacher's `booking_page_locale` (D-194).
 *
 * A locale prefix on a path outside this list is a 404, so a prefix can never
 * make an authenticated route look public.
 */
export const LOCALIZED_PUBLIC_PATHS = [
  "/",
  "/pricing",
  "/features",
  "/about",
  "/help",
  "/terms",
  "/privacy-notice",
] as const;

/** Entries whose whole subtree is localized, not just the page itself. */
const LOCALIZED_SUBTREES: readonly string[] = ["/help"];

export function isLocalizedPublicPath(path: string): boolean {
  for (const entry of LOCALIZED_PUBLIC_PATHS) {
    if (path === entry) return true;
    if (LOCALIZED_SUBTREES.includes(entry) && path.startsWith(`${entry}/`)) return true;
  }
  return false;
}

/** The path prefix a locale's public pages live under; null for DEFAULT_LOCALE. */
export function localePathPrefix(locale: AppLocale): string | null {
  return locale === DEFAULT_LOCALE ? null : `/${locale.toLowerCase()}`;
}

/**
 * Splits a leading locale segment off a pathname: `/es/pricing` →
 * `{ locale: "es", path: "/pricing" }`, `/es` → `{ locale: "es", path: "/" }`.
 * Recognises every registered locale, DEFAULT_LOCALE included, so the
 * middleware can send `/en/pricing` to `/pricing`. Exact lower case only.
 * Null when the path has no locale segment.
 */
export function splitLocalePrefix(pathname: string): { locale: AppLocale; path: string } | null {
  // Launched locales only: an unlaunched one has no URL, so `/de/pricing`
  // passes through to a 404 rather than publishing a half-reviewed page.
  for (const { tag } of LAUNCHED_LOCALES) {
    const locale = tag as AppLocale;
    const prefix = `/${tag.toLowerCase()}`;
    if (pathname === prefix) return { locale, path: "/" };
    if (pathname.startsWith(`${prefix}/`)) return { locale, path: pathname.slice(prefix.length) };
  }
  return null;
}

/** A public path in `locale`'s URL: `("/pricing", "es")` → `/es/pricing`. Any
 * path outside LOCALIZED_PUBLIC_PATHS comes back unchanged. */
export function localizedPath(path: string, locale: AppLocale): string {
  if (!isLocalizedPublicPath(path)) return path;
  const prefix = localePathPrefix(locale);
  if (!prefix) return path;
  return path === "/" ? prefix : `${prefix}${path}`;
}

/** `localizedPath` for an href that may carry a query or a fragment. A
 * relative or external href comes back unchanged. */
export function localizedHref(href: string, locale: AppLocale): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const cut = href.search(/[?#]/);
  const path = cut === -1 ? href : href.slice(0, cut);
  const rest = cut === -1 ? "" : href.slice(cut);
  return `${localizedPath(path, locale)}${rest}`;
}

/**
 * The language a URL names by itself: the prefix's locale on a localized
 * public path, DEFAULT_LOCALE on its bare form, and null for every path the
 * URL does not decide (the app, the funnel, anything prefixed that is not
 * public).
 */
export function publicUrlLocale(pathname: string): AppLocale | null {
  const split = splitLocalePrefix(pathname);
  if (split) return isLocalizedPublicPath(split.path) ? split.locale : null;
  return isLocalizedPublicPath(pathname) ? DEFAULT_LOCALE : null;
}

/** The path a URL names once its locale segment is removed. */
export function unlocalizedPath(pathname: string): string {
  const split = splitLocalePrefix(pathname);
  return split && isLocalizedPublicPath(split.path) ? split.path : pathname;
}

/**
 * The reader's explicit choice, from the `locale` cookie the language
 * switcher writes. "System Default" and an absent cookie are not a choice.
 * A regional value (`es-419`) reduces to its locale, as in getPreferredLocale.
 */
export function explicitLocaleChoice(cookieValue: string | null | undefined): AppLocale | null {
  if (!cookieValue || cookieValue === SYSTEM_LOCALE) return null;
  // A reviewer's cookie may name an unlaunched locale; it reads the app in it,
  // but it never sends the public pages anywhere, since that locale has no URL.
  if (isAppLocale(cookieValue)) return isLaunchedLocale(cookieValue) ? cookieValue : null;
  return matchAcceptLanguage(cookieValue);
}

export type PublicLocaleRoute =
  /** Not a URL that names a language. The request is left alone. */
  | { kind: "pass" }
  /** Render `path` (the URL with its prefix removed) in `locale`. */
  | { kind: "render"; path: string; locale: AppLocale; rewrite: boolean }
  /** Send the reader to `location` (a path plus the original query). */
  | { kind: "redirect"; location: string; status: 302 | 308 };

/**
 * What the middleware does with one request, as a pure function (D-193):
 *
 * - `/es/pricing`: rendered in Spanish, whatever the cookie or header says.
 * - `/en/pricing`: permanently redirected to `/pricing`, its one URL.
 * - `/pricing` with an explicit choice, or with no choice but an
 *   Accept-Language matching another locale: a 302 to that locale's URL.
 *   A GET or HEAD only, and only on arrival from outside the site. A link
 *   inside the site to a bare URL was localized on purpose — "English" on the
 *   Spanish terms is the way to the text that controls (D-196) — so following
 *   it must not bounce the reader back. Otherwise it renders in DEFAULT_LOCALE.
 * - `/terms?lang=es`: the URL sent email carries, permanently redirected to
 *   `/es/terms`.
 * - Everything else, a prefixed non-public path included, passes untouched;
 *   no route exists under a locale segment, so a prefixed private path 404s.
 */
export function resolvePublicLocaleRoute(input: {
  pathname: string;
  search: string;
  method: string;
  localeCookie: string | null | undefined;
  acceptLanguage: string | null | undefined;
  /** The request's Referer is a page of this site. */
  fromThisSite: boolean;
}): PublicLocaleRoute {
  const { pathname, search, method } = input;
  const split = splitLocalePrefix(pathname);

  if (split) {
    if (!isLocalizedPublicPath(split.path)) return { kind: "pass" };
    if (split.locale === DEFAULT_LOCALE) {
      return { kind: "redirect", location: `${split.path}${search}`, status: 308 };
    }
    return { kind: "render", path: split.path, locale: split.locale, rewrite: true };
  }

  if (!isLocalizedPublicPath(pathname)) return { kind: "pass" };

  // The old language switch on /terms, carried by links already in inboxes.
  if (pathname === "/terms") {
    const params = new URLSearchParams(search);
    const lang = params.get("lang");
    if (lang !== null) {
      params.delete("lang");
      const query = params.toString();
      const target = isAppLocale(lang) ? localizedPath(pathname, lang) : pathname;
      return { kind: "redirect", location: `${target}${query ? `?${query}` : ""}`, status: 308 };
    }
  }

  const isNavigation = method === "GET" || method === "HEAD";
  if (isNavigation && !input.fromThisSite) {
    const preferred =
      explicitLocaleChoice(input.localeCookie) ?? matchAcceptLanguage(input.acceptLanguage);
    if (preferred && preferred !== DEFAULT_LOCALE) {
      return {
        kind: "redirect",
        location: `${localizedPath(pathname, preferred)}${search}`,
        status: 302,
      };
    }
  }
  return { kind: "render", path: pathname, locale: DEFAULT_LOCALE, rewrite: false };
}
