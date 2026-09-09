import { afterEach, describe, expect, it, vi } from "vitest";

// `next/headers` is server-only. We mock it so the helper can be tested
// in isolation — the harness sets `cookies()` and `headers()` per test.
const cookieGet = vi.fn();
const hdrGet = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: cookieGet }),
  headers: async () => ({ get: hdrGet }),
}));

// Helper to set both mocks per test. `cookie` is the locale cookie's
// value (`"en"`, `"es-MX"`, or undefined for "not set"); `accept` is the
// raw Accept-Language header value.
function setup({ cookie, accept }: { cookie?: string; accept?: string | null }) {
  cookieGet.mockReset();
  hdrGet.mockReset();
  cookieGet.mockImplementation((name: string) =>
    name === "locale" && cookie ? { value: cookie } : undefined,
  );
  hdrGet.mockImplementation((name: string) =>
    name.toLowerCase() === "accept-language" ? (accept ?? null) : null,
  );
}

describe("getPreferredLocale", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("returns the `locale` cookie when set to a known value", async () => {
    setup({ cookie: "en", accept: "es-MX;q=0.9" });
    const { getPreferredLocale } = await import("@/lib/i18n");
    expect(await getPreferredLocale()).toBe("en");
  });

  it("returns es-MX when the cookie is set to es-MX (header is ignored)", async () => {
    setup({ cookie: "es-MX", accept: "en-US" });
    const { getPreferredLocale } = await import("@/lib/i18n");
    expect(await getPreferredLocale()).toBe("es-MX");
  });

  it("ignores cookies set to unknown values and falls through to header", async () => {
    setup({ cookie: "fr-FR", accept: "es;q=0.9" });
    const { getPreferredLocale } = await import("@/lib/i18n");
    expect(await getPreferredLocale()).toBe("es-MX");
  });

  it("returns es-MX when no cookie + Accept-Language starts with es", async () => {
    setup({ accept: "es-MX,es;q=0.9" });
    const { getPreferredLocale } = await import("@/lib/i18n");
    expect(await getPreferredLocale()).toBe("es-MX");
  });

  it("returns en when no cookie + Accept-Language is empty (English default)", async () => {
    setup({ accept: null });
    const { getPreferredLocale } = await import("@/lib/i18n");
    expect(await getPreferredLocale()).toBe("en");
  });

  it("returns en when no cookie + Accept-Language starts with non-es (e.g. English)", async () => {
    setup({ accept: "en-US,en;q=0.9" });
    const { getPreferredLocale } = await import("@/lib/i18n");
    expect(await getPreferredLocale()).toBe("en");
  });

  it("matches `es` case-insensitively at the start of Accept-Language", async () => {
    setup({ accept: "ES-MX" });
    const { getPreferredLocale } = await import("@/lib/i18n");
    expect(await getPreferredLocale()).toBe("es-MX");
  });

  it("rejects locales that merely contain 'es' later in the header (e.g. 'en;es')", async () => {
    setup({ accept: "en;es" });
    const { getPreferredLocale } = await import("@/lib/i18n");
    expect(await getPreferredLocale()).toBe("en");
  });

  it("LOCALE_COOKIE is the literal 'locale' (used by the toggle action)", async () => {
    const { LOCALE_COOKIE } = await import("@/lib/i18n");
    expect(LOCALE_COOKIE).toBe("locale");
  });

  it("falls back to the default locale when called outside a request scope", async () => {
    // cookies()/headers() throw outside a Next request (tests, build-time SSG).
    cookieGet.mockReset();
    hdrGet.mockReset();
    cookieGet.mockImplementation(() => {
      throw new Error("called outside a request scope");
    });
    const { getPreferredLocale } = await import("@/lib/i18n");
    expect(await getPreferredLocale()).toBe("en");
  });
});

describe("getT", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("returns a t() bound to the request's preferred locale", async () => {
    setup({ cookie: "es-MX" });
    const { getT } = await import("@/lib/i18n");
    const t = await getT();
    expect(t("common.save")).toBe("Guardar");
    expect(t("home.greeting", { name: "Mira" })).toBe("Hola, Mira");
  });

  it("resolves English copy when the preferred locale is en", async () => {
    setup({ cookie: "en" });
    const { getT } = await import("@/lib/i18n");
    const t = await getT();
    expect(t("common.save")).toBe("Save");
  });
});
