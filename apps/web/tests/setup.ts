import { vi } from "vitest";

// Tests pre-date the i18n migration and assert on the original Spanish
// error strings. Pin the test environment to es so getPreferredLocale()
// returns it everywhere — tests that need to exercise the English path
// should override this mock in-file.
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "locale" ? { value: "es" } : undefined),
  }),
  headers: async () => ({ get: () => null }),
}));

// jsdom implements no `window.matchMedia`, and vitest 5's global population
// defines the key anyway as an accessor that returns undefined — so
// `vi.spyOn(window, "matchMedia")` fails with "can only spy on a function"
// where it worked under vitest 3. Give the jsdom-environment files a real
// function to spy on. Defaults to not-matching; each test sets its own return
// value, and `vi.restoreAllMocks()` restores it to this stub rather than to
// undefined.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}

// The app loads each language's catalog behind its own `import()`
// (src/components/locale-catalog/loader.tsx), so a browser fetches one
// language. In a test that is a component that renders nothing on its first,
// synchronous pass. Replace only that indirection: the per-language modules
// and the provider they render are the real ones. Whether the split holds is
// asserted on the built chunks (scripts/catalog-chunks.mjs), not here.
vi.mock("@/components/locale-catalog/loader", async () => {
  const { default: en } = await import("@/components/locale-catalog/en");
  const { default: es } = await import("@/components/locale-catalog/es");
  const { default: fr } = await import("@/components/locale-catalog/fr");
  const catalogs = { en, es, fr } as const;
  return {
    CatalogLoader: ({ locale, children }: { locale: keyof typeof catalogs; children: never }) =>
      catalogs[locale]({ children }),
  };
});
