import { describe, expect, it, vi } from "vitest";
import type { LocaleDefinition } from "./locale-registry";

// A locale lands with `launched: false` while its catalog is written and read
// by a native speaker (D-81), and before its legal translations exist (D-196).
// Until it is flipped it must reach no reader who did not go looking, and no
// search engine (D-193). Every locale shipped today is launched, so this adds
// an unlaunched German row to the registry and checks each reader-facing path
// leaves it out while stored values still resolve.

const GERMAN: LocaleDefinition = {
  tag: "de",
  languageCode: "de",
  label: "Deutsch",
  englishName: "German",
  match: /^de\b/i,
  intl: "de",
  og: "de_DE",
  dir: "ltr",
  ownCurrencySymbol: "symbol",
  launched: false,
};

vi.mock("./locale-registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("./locale-registry")>();
  return { ...original, LOCALES: [...original.LOCALES, GERMAN] };
});

const locales = await import("./locales");
const paths = await import("./localized-paths");

describe("an unlaunched locale", () => {
  it("is registered, so a stored value still resolves", () => {
    expect(locales.isAppLocale("de")).toBe(true);
    expect(locales.localeToLanguageCode("de")).toBe("de");
    expect(locales.languageCodeToLocale("de")).toBe("de");
  });

  it("is not offered in the language picker", () => {
    const offered = locales.localeOptions("System").map((o) => o.value);
    expect(offered).not.toContain("de");
    expect(offered).toEqual(expect.arrayContaining(["en", "es", "fr"]));
  });

  it("is not detected from the browser", () => {
    expect(locales.matchAcceptLanguage("de-DE,de;q=0.9")).toBeNull();
    expect(locales.isLaunchedLocale("de")).toBe(false);
    expect(locales.isLaunchedLocale("fr")).toBe(true);
  });

  it("has no URL: its prefix is not a locale prefix, so the path 404s", () => {
    expect(paths.splitLocalePrefix("/de/pricing")).toBeNull();
    expect(paths.publicUrlLocale("/de/pricing")).toBeNull();
    expect(
      paths.resolvePublicLocaleRoute({
        pathname: "/de/pricing",
        search: "",
        method: "GET",
        localeCookie: null,
        acceptLanguage: null,
        fromThisSite: false,
      }),
    ).toEqual({ kind: "pass" });
  });

  it("never sends a reader of the public pages to it, by cookie or by browser", () => {
    expect(paths.explicitLocaleChoice("de")).toBeNull();
    const bare = (cookie: string | null, accept: string | null) =>
      paths.resolvePublicLocaleRoute({
        pathname: "/pricing",
        search: "",
        method: "GET",
        localeCookie: cookie,
        acceptLanguage: accept,
        fromThisSite: false,
      });
    expect(bare("de", null)).toMatchObject({ kind: "render", locale: "en" });
    expect(bare(null, "de-DE")).toMatchObject({ kind: "render", locale: "en" });
  });

  it("is left out of the launched list", () => {
    expect(locales.LAUNCHED_LOCALES.map((l) => l.tag)).not.toContain("de");
  });
});
