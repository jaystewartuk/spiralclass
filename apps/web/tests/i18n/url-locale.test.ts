import { beforeEach, describe, expect, it, vi } from "vitest";

// D-193: on a public page the URL names the language, and the middleware hands
// it on as `x-locale`. These pin the request-scoped helpers that read it.

const request = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  cookie: undefined as string | undefined,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "locale" && request.cookie !== undefined ? { value: request.cookie } : undefined,
  }),
  headers: async () => ({ get: (name: string) => request.headers.get(name) ?? null }),
}));

const { getPreferredLocale, getLanguagePickerValue, getLocalizedHref } = await import("@/lib/i18n");

beforeEach(() => {
  request.headers.clear();
  request.cookie = undefined;
});

describe("getPreferredLocale", () => {
  it("is the URL's language on a public page, over the cookie and the browser", async () => {
    request.headers.set("x-locale", "fr");
    request.headers.set("accept-language", "es-MX");
    request.cookie = "en";
    expect(await getPreferredLocale()).toBe("fr");
  });

  it("falls back to the cookie, then the browser, where the URL names nothing", async () => {
    request.cookie = "es";
    request.headers.set("accept-language", "fr");
    expect(await getPreferredLocale()).toBe("es");
    request.cookie = undefined;
    expect(await getPreferredLocale()).toBe("fr");
  });

  it("ignores an x-locale that is not a registered locale", async () => {
    request.headers.set("x-locale", "klingon");
    request.cookie = "es";
    expect(await getPreferredLocale()).toBe("es");
  });
});

describe("getLanguagePickerValue", () => {
  it("is the stored preference when the page is in the language it resolves to", async () => {
    request.cookie = "es";
    request.headers.set("x-locale", "es");
    expect(await getLanguagePickerValue()).toBe("es");
    request.cookie = "system";
    request.headers.set("accept-language", "fr-CA");
    request.headers.set("x-locale", "fr");
    expect(await getLanguagePickerValue()).toBe("system");
  });

  // A reader who prefers English arrives at /es/pricing from a search. If the
  // picker showed English, choosing English would not fire a change at all.
  it("is the page's own language when the URL names one the preference does not", async () => {
    request.cookie = "en";
    request.headers.set("x-locale", "es");
    expect(await getLanguagePickerValue()).toBe("es");
    request.cookie = "system";
    request.headers.set("accept-language", "en-US");
    expect(await getLanguagePickerValue()).toBe("es");
  });

  it("is the stored preference on a page the URL does not decide", async () => {
    request.cookie = "fr";
    expect(await getLanguagePickerValue()).toBe("fr");
  });
});

describe("getLocalizedHref", () => {
  it("builds public links in the page's language and leaves the rest alone", async () => {
    request.headers.set("x-locale", "es");
    const href = await getLocalizedHref();
    expect(href("/pricing")).toBe("/es/pricing");
    expect(href("/dashboard")).toBe("/dashboard");
  });
});
