import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, LOCALES } from "./locales";
import {
  LOCALIZED_PUBLIC_PATHS,
  explicitLocaleChoice,
  isLocalizedPublicPath,
  localePathPrefix,
  localizedHref,
  localizedPath,
  publicUrlLocale,
  resolvePublicLocaleRoute,
  splitLocalePrefix,
  unlocalizedPath,
} from "./localized-paths";

// D-193: one URL per language for the public pages, the bare URL in
// DEFAULT_LOCALE, and the URL — not the cookie or the header — deciding what
// a page it names renders in.

const OTHER = LOCALES.filter((l) => l.tag !== DEFAULT_LOCALE).map((l) => l.tag);

function route(
  pathname: string,
  opts: {
    search?: string;
    method?: string;
    cookie?: string | null;
    accept?: string | null;
    fromThisSite?: boolean;
  } = {},
) {
  return resolvePublicLocaleRoute({
    pathname,
    search: opts.search ?? "",
    method: opts.method ?? "GET",
    localeCookie: opts.cookie ?? null,
    acceptLanguage: opts.accept ?? null,
    fromThisSite: opts.fromThisSite ?? false,
  });
}

describe("the localized public paths", () => {
  it("covers the marketing, help and legal pages, and the help subtree", () => {
    for (const path of LOCALIZED_PUBLIC_PATHS) expect(isLocalizedPublicPath(path), path).toBe(true);
    expect(isLocalizedPublicPath("/help/teachers/getting-paid")).toBe(true);
  });

  it("never covers the app, the funnel, auth, admin or the API", () => {
    for (const path of [
      "/dashboard",
      "/settings/payments",
      "/my-classes",
      "/admin",
      "/b/ana",
      "/sign-in",
      "/api/health",
      "/pricing-old",
      "/terms/extra",
    ]) {
      expect(isLocalizedPublicPath(path), path).toBe(false);
    }
  });
});

describe("prefixes", () => {
  it("gives DEFAULT_LOCALE no prefix and every other locale its lower-cased tag", () => {
    expect(localePathPrefix(DEFAULT_LOCALE)).toBeNull();
    for (const tag of OTHER) expect(localePathPrefix(tag)).toBe(`/${tag.toLowerCase()}`);
  });

  it("splits a locale segment off, and only a whole segment", () => {
    expect(splitLocalePrefix("/es/pricing")).toEqual({ locale: "es", path: "/pricing" });
    expect(splitLocalePrefix("/fr")).toEqual({ locale: "fr", path: "/" });
    expect(splitLocalePrefix("/en/help/teachers")).toEqual({
      locale: "en",
      path: "/help/teachers",
    });
    expect(splitLocalePrefix("/essay")).toBeNull();
    expect(splitLocalePrefix("/pricing")).toBeNull();
    expect(splitLocalePrefix("/ES/pricing")).toBeNull();
  });

  it("builds a page's URL in each locale and leaves other paths alone", () => {
    expect(localizedPath("/pricing", "es")).toBe("/es/pricing");
    expect(localizedPath("/", "fr")).toBe("/fr");
    expect(localizedPath("/pricing", DEFAULT_LOCALE)).toBe("/pricing");
    expect(localizedPath("/dashboard", "es")).toBe("/dashboard");
    expect(localizedPath("/b/ana", "fr")).toBe("/b/ana");
  });

  it("keeps an href's query and fragment, and leaves external hrefs alone", () => {
    expect(localizedHref("/terms#cancellation-policy", "es")).toBe("/es/terms#cancellation-policy");
    expect(localizedHref("/help?q=pay", "fr")).toBe("/fr/help?q=pay");
    expect(localizedHref("https://example.com/pricing", "es")).toBe("https://example.com/pricing");
    expect(localizedHref("//example.com/pricing", "es")).toBe("//example.com/pricing");
    expect(localizedHref("#top", "es")).toBe("#top");
  });

  it("round-trips: the URL a page gets names that page and that language", () => {
    for (const { tag } of LOCALES) {
      for (const path of [...LOCALIZED_PUBLIC_PATHS, "/help/students/booking"]) {
        const url = localizedPath(path, tag);
        expect(publicUrlLocale(url), url).toBe(tag);
        expect(unlocalizedPath(url), url).toBe(path);
      }
    }
  });

  it("says a URL outside the public pages names no language", () => {
    expect(publicUrlLocale("/dashboard")).toBeNull();
    expect(publicUrlLocale("/es/dashboard")).toBeNull();
    expect(publicUrlLocale("/b/ana")).toBeNull();
    expect(unlocalizedPath("/es/dashboard")).toBe("/es/dashboard");
  });
});

describe("explicitLocaleChoice", () => {
  it("is the cookie's locale, and nothing for System Default or no cookie", () => {
    expect(explicitLocaleChoice("fr")).toBe("fr");
    expect(explicitLocaleChoice("es-419")).toBe("es");
    expect(explicitLocaleChoice("system")).toBeNull();
    expect(explicitLocaleChoice(undefined)).toBeNull();
    expect(explicitLocaleChoice("zz")).toBeNull();
  });
});

describe("resolvePublicLocaleRoute", () => {
  it("renders a prefixed public page in its URL's language, whatever the reader prefers", () => {
    expect(route("/es/pricing", { cookie: "en", accept: "fr-FR" })).toEqual({
      kind: "render",
      path: "/pricing",
      locale: "es",
      rewrite: true,
    });
    expect(route("/fr", { method: "POST" })).toEqual({
      kind: "render",
      path: "/",
      locale: "fr",
      rewrite: true,
    });
  });

  it("sends the default locale's prefix to the bare URL, its one URL", () => {
    expect(route("/en/pricing", { search: "?ref=abc" })).toEqual({
      kind: "redirect",
      location: "/pricing?ref=abc",
      status: 308,
    });
    expect(route("/en")).toEqual({ kind: "redirect", location: "/", status: 308 });
  });

  it("passes a prefixed private path through untouched, so it 404s", () => {
    for (const path of ["/es/dashboard", "/fr/admin", "/es/b/ana", "/en/sign-in", "/es/api/x"]) {
      expect(route(path, { cookie: "es" }), path).toEqual({ kind: "pass" });
    }
  });

  it("renders the bare URL in DEFAULT_LOCALE when nothing prefers another", () => {
    // A crawler sends no cookie and no Accept-Language.
    expect(route("/pricing")).toEqual({
      kind: "render",
      path: "/pricing",
      locale: DEFAULT_LOCALE,
      rewrite: false,
    });
    expect(route("/pricing", { accept: "en-GB,en;q=0.9" }).kind).toBe("render");
    expect(route("/pricing", { cookie: "system", accept: "de-DE" }).kind).toBe("render");
  });

  it("redirects the bare URL to the browser's language when there is no explicit choice", () => {
    expect(route("/pricing", { accept: "es-MX,es;q=0.9", search: "?ref=x" })).toEqual({
      kind: "redirect",
      location: "/es/pricing?ref=x",
      status: 302,
    });
    expect(route("/", { cookie: "system", accept: "fr-CA" })).toEqual({
      kind: "redirect",
      location: "/fr",
      status: 302,
    });
  });

  it("lets the switcher's choice beat the browser", () => {
    expect(route("/pricing", { cookie: "en", accept: "es-MX" }).kind).toBe("render");
    expect(route("/help/teachers", { cookie: "fr", accept: "en-US" })).toEqual({
      kind: "redirect",
      location: "/fr/help/teachers",
      status: 302,
    });
  });

  // A link inside the site to a bare URL was localized on purpose. The
  // "English" link on the Spanish terms is the way to the text that controls
  // (D-196); bouncing a Spanish-preferring reader back to /es/terms would make
  // it unreachable for them.
  it("never redirects a link followed from inside the site", () => {
    expect(route("/terms", { cookie: "es", accept: "es-MX", fromThisSite: true })).toEqual({
      kind: "render",
      path: "/terms",
      locale: DEFAULT_LOCALE,
      rewrite: false,
    });
    // The same request arriving from outside is redirected.
    expect(route("/terms", { cookie: "es", accept: "es-MX" })).toEqual({
      kind: "redirect",
      location: "/es/terms",
      status: 302,
    });
  });

  it("never redirects a request that is not a navigation", () => {
    expect(route("/pricing", { method: "POST", accept: "es" })).toEqual({
      kind: "render",
      path: "/pricing",
      locale: DEFAULT_LOCALE,
      rewrite: false,
    });
  });

  it("sends the old /terms?lang= links to the language's own URL", () => {
    expect(route("/terms", { search: "?lang=es" })).toEqual({
      kind: "redirect",
      location: "/es/terms",
      status: 308,
    });
    expect(route("/terms", { search: "?lang=en&x=1", accept: "es" })).toEqual({
      kind: "redirect",
      location: "/terms?x=1",
      status: 308,
    });
    expect(route("/terms", { search: "?lang=zz" })).toEqual({
      kind: "redirect",
      location: "/terms",
      status: 308,
    });
  });

  it("leaves every non-public path alone", () => {
    for (const path of ["/dashboard", "/b/ana", "/sign-in", "/api/health", "/my-classes"]) {
      expect(route(path, { accept: "es", cookie: "fr" }), path).toEqual({ kind: "pass" });
    }
  });
});
