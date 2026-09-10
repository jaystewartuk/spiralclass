import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A reader who has not stated a language gets DEFAULT_LOCALE.
 *
 * The product ships three UI locales and every surface resolves one, so what
 * is worth pinning is the unforced case — no cookie, no Accept-Language, or a
 * value that matches nothing. That answer is DEFAULT_LOCALE everywhere, and
 * these are the surfaces where it is easiest to get wrong quietly:
 *
 *   1. Pages that build their own HTML because they render outside the app
 *      shell — the unsubscribe flow and the two expired-link pages. They have
 *      no layout to inherit a locale from, so each resolves its own.
 *   2. Resolvers with a fallback of their own — `getPreferredLocale`, the
 *      client locale context, the crash page. A wrong fallback here is quiet:
 *      it looks right to anyone whose browser happens to match, and only the
 *      unmatched reader ever sees it.
 *
 * Each test states the request it is making rather than leaning on the suite
 * default in tests/setup.ts: the assertion is about which way a request is
 * followed, and a default nobody can see is the wrong thing to hang that on.
 * A test asserting Spanish is asserting that the resolver ran.
 */

/**
 * Load a module with `next/headers` answering as a given request would.
 *
 * The locale is read through `next/headers`, which every module resolves at
 * import time, so changing the answer means resetting the module registry and
 * importing again. Restore with a mock rather than `vi.doUnmock`: unmocking
 * drops tests/setup.ts's own `next/headers` mock along with this one, and the
 * real thing throws outside a request scope — which lands on the DEFAULT_LOCALE
 * catch and quietly makes every later test in the file pass for the wrong
 * reason.
 */
async function asRequest<T>(
  request: { cookie?: string; acceptLanguage?: string },
  load: () => Promise<T>,
): Promise<T> {
  vi.doMock("next/headers", () => ({
    cookies: async () => ({
      get: (name: string) =>
        name === "locale" && request.cookie ? { value: request.cookie } : undefined,
    }),
    headers: async () => ({
      get: (h: string) => (h === "accept-language" ? (request.acceptLanguage ?? null) : null),
    }),
  }));
  vi.resetModules();
  return await load();
}

/** No cookie, no Accept-Language — the reader who asked for nothing. */
const asAnybody = <T>(load: () => Promise<T>) => asRequest({}, load);

afterEach(async () => {
  await asRequest({ cookie: "es-MX" }, async () => {});
});

describe("unsubscribe pages", () => {
  const token = "any-token";
  const ctx = { params: Promise.resolve({ token }) };
  const req = new Request("https://app.test/r/email-uns/any-token") as never;

  it("confirms in English when the reader asks for nothing in particular", async () => {
    const { GET } = await asAnybody(() => import("@/app/r/email-uns/[token]/route"));
    const html = await (await GET(req, ctx)).text();
    expect(html).toContain('lang="en"');
    expect(html).toContain("Stop these emails?");
    expect(html).toContain("Yes, stop my emails");
    // Explicitly not another locale's copy: the page picks one and renders it.
    expect(html).not.toContain("¿Cancelar los correos?");
  });

  it("confirms in Spanish when the reader has chosen Spanish", async () => {
    const { GET } = await asRequest(
      { cookie: "es-MX" },
      () => import("@/app/r/email-uns/[token]/route"),
    );
    const html = await (await GET(req, ctx)).text();
    expect(html).toContain('lang="es-MX"');
    expect(html).toContain("¿Cancelar los correos?");
  });

  it("confirms in French", async () => {
    const { GET } = await asRequest(
      { acceptLanguage: "fr-FR,fr" },
      () => import("@/app/r/email-uns/[token]/route"),
    );
    const html = await (await GET(req, ctx)).text();
    expect(html).toContain('lang="fr"');
    expect(html).toContain("Arrêter ces e-mails ?");
  });

  // The confirmation page is served to every corporate link-scanner and
  // prefetcher that touches an email (RFC 8058 is the reason GET does not
  // unsubscribe). Resolving the locale must not have turned it into a DB read.
  it("still touches no database to render the confirmation", async () => {
    const prismaAccess = vi.fn();
    vi.doMock("@/lib/prisma", () => ({
      get prisma() {
        prismaAccess();
        return {};
      },
    }));
    const { GET } = await asAnybody(() => import("@/app/r/email-uns/[token]/route"));
    await GET(req, ctx);
    expect(prismaAccess).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/prisma");
  });
});

describe("locale resolvers", () => {
  it("getPreferredLocale falls back to DEFAULT_LOCALE, not to Spanish", async () => {
    const { getPreferredLocale } = await asAnybody(() => import("@/lib/i18n"));
    const { DEFAULT_LOCALE } = await import("@spiralclass/shared");
    expect(await getPreferredLocale()).toBe(DEFAULT_LOCALE);
    expect(await getPreferredLocale()).toBe("en");
  });

  it("the client locale context defaults to DEFAULT_LOCALE", async () => {
    // A tree with no LocaleProvider above it still has to resolve something.
    // Nothing renders that way today, which is exactly why a wrong default
    // here would never announce itself.
    const { useLocale } = await import("@/components/locale-provider");
    const { DEFAULT_LOCALE } = await import("@spiralclass/shared");
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    function Probe() {
      return React.createElement("i", null, useLocale());
    }
    expect(renderToStaticMarkup(React.createElement(Probe))).toBe(`<i>${DEFAULT_LOCALE}</i>`);
  });

  // global-error renders when the root layout itself threw, so there is no
  // LocaleProvider and no request context to read: it resolves the locale
  // client-side and has to pick something for the server render first. This is
  // the app's worst screen, and the reader cannot navigate away from it, so
  // the one it picks unasked is worth pinning. The assertion covers that
  // initial render only — the client refinement is the useEffect after it.
  it("the crash page's server render is DEFAULT_LOCALE", async () => {
    const React = await import("react");
    // App components are transformed expecting React in scope (see
    // tests/components/url-search-input.test.tsx, which does the same).
    (globalThis as Record<string, unknown>).React = React;
    const { default: GlobalError } = await import("@/app/global-error");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(
      React.createElement(GlobalError, { error: Object.assign(new Error("boom")) }),
    );
    expect(html).toContain('lang="en"');
    expect(html).toContain("We had a problem loading the app.");
    expect(html).not.toContain("Tuvimos un problema");
  });
});
