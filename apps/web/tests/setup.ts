import { vi } from "vitest";

// Tests pre-date the i18n migration and assert on the original Spanish
// error strings. Pin the test environment to es-MX so getPreferredLocale()
// returns it everywhere — tests that need to exercise the English path
// should override this mock in-file.
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "locale" ? { value: "es-MX" } : undefined),
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
