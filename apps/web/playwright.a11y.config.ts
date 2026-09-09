import { defineConfig, devices } from "@playwright/test";

// Accessibility sweep — a separate Playwright project from the happy-path E2E
// suite (playwright.config.ts, testDir ./tests/e2e).
//
// Kept separate for two reasons. The E2E suite runs serially with workers:1
// because it mutates real booking/payment state; the a11y sweep is read-only
// and parallelises freely. And the E2E suite is a promote-time gate that must
// stay fast and deterministic — bolting a couple of hundred axe scans onto it
// would slow the thing standing between a commit and production.
//
// TARGET: a DEPLOYED environment, not a local build. Every route here is
// server-rendered against a real database (the booking funnel reads a teacher,
// their availability and their packages), so a local run would need the whole
// stack up. Pointing at preview is the same approach the Maestro flows take.
// Override with A11Y_BASE_URL to scan production or a local `pnpm dev`.

const baseURL = process.env.A11Y_BASE_URL ?? "https://preview.spiralclass.com";
const isCI = Boolean(process.env.CI);

// Playwright's "Desktop Chrome" preset is 1280x720, which is BELOW
// DESKTOP_MIN_WIDTH (1281) — so an unpinned project renders the mobile layout
// and still passes every assertion, silently retiring desktop coverage instead
// of failing. Pin the viewport above `lg` (1440) so these suites exercise the
// full desktop scale. See src/lib/breakpoints.ts.
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

export default defineConfig({
  testDir: "./tests/a11y",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [["html", { open: "never" }], ["list"]] : "list",

  use: {
    baseURL,
    // Bounded so a missing element fails in seconds naming itself, rather than
    // burning the whole test timeout and reporting only "timeout exceeded" —
    // the same reasoning as playwright.config.ts.
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  // Both production audiences. Locale is resolved from Accept-Language when no
  // `locale` cookie is set (see getPreferredLocale in src/lib/i18n.ts), and
  // Playwright's `locale` option sets that header — so these two projects
  // genuinely exercise the Spanish teacher-facing and English student-facing
  // renders, not the same markup twice.
  //
  // Worth doing because a contrast or label regression can exist in one locale
  // and not the other: a longer Spanish string wraps differently, and a missing
  // translation falls back to an English label inside a Spanish page. Scanning
  // only one locale would miss both, and "only broken for Spanish users" is
  // exactly the kind of bug that survives for months here.
  projects: [
    {
      name: "es-MX",
      use: {
        ...devices["Desktop Chrome"],
        viewport: DESKTOP_VIEWPORT,
        locale: "es-MX",
        timezoneId: "America/Mexico_City",
      },
    },
    {
      name: "en",
      use: {
        ...devices["Desktop Chrome"],
        viewport: DESKTOP_VIEWPORT,
        locale: "en-US",
        timezoneId: "America/Mexico_City",
      },
    },
    // DARK MODE, added 2026-09-01. Both projects above render light, so half
    // the product was unmeasured — and that is not hypothetical: `primary` sat
    // at 3.49:1 as text on a dark raised card, below AA at 50 call sites, for
    // as long as this sweep has existed. The theme switches on
    // `prefers-color-scheme` when the reader has expressed no preference, which
    // is what `colorScheme` sets here.
    //
    // ONE dark project, not two. Theme and locale are orthogonal: a contrast
    // failure does not depend on the string, and the string-length failures the
    // two locales exist to catch (a longer Spanish label wrapping, a missing
    // translation) do not depend on the theme. Doubling to four would double the
    // runtime of a suite whose header already argues that a sweep nobody waits
    // for is a sweep nobody runs.
    {
      name: "en-dark",
      use: {
        ...devices["Desktop Chrome"],
        viewport: DESKTOP_VIEWPORT,
        locale: "en-US",
        timezoneId: "America/Mexico_City",
        colorScheme: "dark",
      },
    },
  ],
});
