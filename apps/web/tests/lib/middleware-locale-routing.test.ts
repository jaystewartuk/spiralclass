import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// D-193: one URL per language for the public pages. The decision itself is a
// pure function tested in packages/shared (localized-paths.test.ts); this pins
// what the middleware does with it on real NextRequests — the rewrite, the
// header it hands the page, and the redirects. middleware-session.test.ts
// covers the rest of updateSession.

const getSessionCookie = vi.fn();
vi.mock("better-auth/cookies", () => ({
  getSessionCookie: (req: unknown) => getSessionCookie(req),
  getCookieCache: vi.fn(async () => null),
}));

const APP_URL = "https://preview.spiralclass.com";
vi.mock("@/lib/env", () => ({
  isSuperuser: () => false,
  serverEnv: () => ({ BETTER_AUTH_SECRET: "test-secret", APP_URL }),
}));

const { updateSession } = await import("@/lib/auth/middleware");

// Next hands a middleware-set request header to the page as this.
const urlLocaleOf = (res: Response) => res.headers.get("x-middleware-request-x-locale");

function navigation(
  path: string,
  opts: { accept?: string; cookie?: string; referer?: string; xLocale?: string } = {},
) {
  const headers = new Headers();
  if (opts.accept) headers.set("accept-language", opts.accept);
  if (opts.referer) headers.set("referer", opts.referer);
  if (opts.xLocale) headers.set("x-locale", opts.xLocale);
  const req = new NextRequest(`http://localhost${path}`, { headers });
  if (opts.cookie) req.cookies.set("locale", opts.cookie);
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionCookie.mockReturnValue(null);
  vi.stubEnv("CSP_ENFORCE", "0");
});

describe("updateSession — a public page's URL decides its language", () => {
  it("serves /es/pricing from the /pricing route, in Spanish, whatever the reader prefers", async () => {
    const res = await updateSession(navigation("/es/pricing", { cookie: "en", accept: "fr" }));
    expect(new URL(res.headers.get("x-middleware-rewrite")!).pathname).toBe("/pricing");
    expect(urlLocaleOf(res)).toBe("es");
    expect(res.headers.get("location")).toBeNull();
    // The CSP still goes on a rewritten page.
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeTruthy();
  });

  it("serves a help article under its prefix, and the root as /fr", async () => {
    const article = await updateSession(navigation("/fr/help/teachers/getting-paid"));
    expect(new URL(article.headers.get("x-middleware-rewrite")!).pathname).toBe(
      "/help/teachers/getting-paid",
    );
    const root = await updateSession(navigation("/fr"));
    expect(new URL(root.headers.get("x-middleware-rewrite")!).pathname).toBe("/");
    expect(urlLocaleOf(root)).toBe("fr");
  });

  it("renders the bare URL in English for a reader with no other preference, or a crawler", async () => {
    const res = await updateSession(navigation("/pricing"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("location")).toBeNull();
    expect(urlLocaleOf(res)).toBe("en");
  });

  // A client could otherwise choose the language of any page — the app's
  // included — by sending the header getPreferredLocale reads first.
  it("throws away an x-locale header the client sent", async () => {
    getSessionCookie.mockReturnValue("session-token");
    const res = await updateSession(navigation("/dashboard", { xLocale: "fr" }));
    expect(urlLocaleOf(res)).toBeNull();
    // And on a public page, the URL's value replaces it.
    const pub = await updateSession(navigation("/pricing", { xLocale: "fr" }));
    expect(urlLocaleOf(pub)).toBe("en");
  });

  it("redirects a reader arriving from outside to their language's URL, privately", async () => {
    const res = await updateSession(navigation("/pricing?ref=abc", { accept: "es-MX,es;q=0.9" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_URL}/es/pricing?ref=abc`);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Vary")).toBe("Cookie, Accept-Language");
  });

  it("does not redirect a link followed from inside the site", async () => {
    const res = await updateSession(
      navigation("/terms", { cookie: "es", referer: `${APP_URL}/es/terms` }),
    );
    expect(res.headers.get("location")).toBeNull();
    expect(urlLocaleOf(res)).toBe("en");
  });

  it("treats a Referer from another site as arriving from outside, lookalike names included", async () => {
    const res = await updateSession(
      navigation("/terms", { cookie: "es", referer: `${APP_URL}.evil.test/x` }),
    );
    expect(res.headers.get("location")).toBe(`${APP_URL}/es/terms`);
  });

  it("sends /en/… to the bare URL permanently, and old /terms?lang= links to their URL", async () => {
    const en = await updateSession(navigation("/en/features"));
    expect(en.status).toBe(308);
    expect(en.headers.get("location")).toBe(`${APP_URL}/features`);

    const legacy = await updateSession(navigation("/terms?lang=es"));
    expect(legacy.status).toBe(308);
    expect(legacy.headers.get("location")).toBe(`${APP_URL}/es/terms`);
  });

  it("leaves a prefixed private path alone, so no route answers it", async () => {
    getSessionCookie.mockReturnValue("session-token");
    for (const path of ["/es/dashboard", "/fr/admin", "/es/b/mira"]) {
      const res = await updateSession(navigation(path));
      expect(res.headers.get("x-middleware-rewrite"), path).toBeNull();
      expect(res.headers.get("location"), path).toBeNull();
      expect(urlLocaleOf(res), path).toBeNull();
    }
  });
});
