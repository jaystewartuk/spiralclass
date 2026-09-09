import { defineConfig, devices } from "@playwright/test";

// Happy-path E2E. Single browser (Chromium), single project. The suite
// assumes a real Supabase + Postgres + service-role stack is reachable;
// CI skips the test gracefully when env vars aren't set (see
// tests/e2e/happy-path.spec.ts top-level guard).
//
// Local: `pnpm dev` first, then `pnpm test:e2e`. The webServer block is
// guarded by PLAYWRIGHT_NO_WEBSERVER (set in CI) so PRs that don't bring
// up the app aren't held hostage to a long boot.

// Playwright's "Desktop Chrome" preset is 1280x720, which is BELOW
// DESKTOP_MIN_WIDTH (1281) — so an unpinned project renders the mobile layout
// and still passes every assertion, silently retiring desktop coverage instead
// of failing. Pin the viewport above `lg` (1440) so these suites exercise the
// full desktop scale. See src/lib/breakpoints.ts.
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

const isCI = Boolean(process.env.CI);
const skipWebServer = process.env.PLAYWRIGHT_NO_WEBSERVER === "1";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  // `next dev` compiles each route on first hit (6–15s on a CI runner), which
  // outruns Playwright's 5s default assertion timeout — a `toHaveURL` after a
  // navigation to an as-yet-uncompiled route would fail even though the app is
  // working. Give web-first assertions room for a cold compile.
  expect: { timeout: 30_000 },
  reporter: isCI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL,
    // Both default to 0 — meaning "wait forever". An action against a locator
    // that never resolves (renamed label, route that renders an error) then
    // burns the WHOLE test timeout and reports only "Test timeout of 240000ms
    // exceeded", naming nothing: no failing locator, and — since the html
    // reporter only writes on exit — no report at all once enough tests hang
    // to blow the job's own timeout first. Three specs hanging 4 minutes each
    // is also what makes the suite overrun `timeout-minutes` in e2e.yml.
    // Bound them so a missing element fails in seconds, pointing at itself.
    // 30s, matching expect.timeout above: same cold-compile headroom, so this
    // only ever fires on a genuinely absent element, never a slow one.
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    // The happy-path suite asserts Spanish copy (e.g. the "Hola" dashboard
    // greeting). getPreferredLocale() returns es-MX only when Accept-Language
    // starts with "es"; without pinning these, a runner whose default locale
    // is en-US (GitHub CI) renders English and the assertions fail. Pin to the
    // launch market so the suite is deterministic regardless of host locale.
    locale: "es-MX",
    timezoneId: "America/Mexico_City",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: DESKTOP_VIEWPORT },
    },
  ],
  webServer:
    isCI || skipWebServer
      ? undefined
      : {
          command: "pnpm dev",
          url: baseURL,
          reuseExistingServer: true,
          timeout: 120 * 1000,
        },
});
