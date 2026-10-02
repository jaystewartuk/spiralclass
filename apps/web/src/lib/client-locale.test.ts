import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LOCALE, LOCALES } from "@spiralclass/shared";
import { CLIENT_LOCALE_COOKIE, detectClientLocale } from "./client-locale";

describe("detectClientLocale", () => {
  it("resolves every registered locale from its saved cookie, with no list of its own", () => {
    // The point of the function: a language added to the registry is detected
    // here without this file changing.
    for (const { tag } of LOCALES) {
      expect(detectClientLocale(`theme=dark; locale=${tag}`, "xx")).toBe(tag);
    }
  });

  it("resolves every registered locale from the browser's language", () => {
    for (const { tag } of LOCALES) {
      expect(detectClientLocale("", `${tag}-XX`)).toBe(tag);
    }
  });

  it("prefers the reader's saved choice to the browser's language", () => {
    expect(detectClientLocale("locale=fr", "es-MX")).toBe("fr");
  });

  it("follows the browser when the saved choice is System Default", () => {
    expect(detectClientLocale("locale=system", "es-MX")).toBe("es");
  });

  it("reduces a regional cookie to its locale, as the server does", () => {
    expect(detectClientLocale("locale=es-419", "en-GB")).toBe("es");
  });

  it("is not fooled by a cookie whose name merely ends in the same word", () => {
    expect(detectClientLocale("booking_locale=es", "fr-FR")).toBe("fr");
  });

  it("answers DEFAULT_LOCALE when nothing matches, and never throws", () => {
    expect(detectClientLocale(undefined, undefined)).toBe(DEFAULT_LOCALE);
    expect(detectClientLocale("locale=pl", "de-AT")).toBe(DEFAULT_LOCALE);
    expect(detectClientLocale("locale=%E0%A4%A", null)).toBe(DEFAULT_LOCALE);
  });

  it("reads the same cookie the server writes", async () => {
    vi.doMock("next/headers", () => ({ cookies: async () => ({}), headers: async () => ({}) }));
    const { LOCALE_COOKIE } = await import("./i18n");
    expect(CLIENT_LOCALE_COOKIE).toBe(LOCALE_COOKIE);
  });
});
