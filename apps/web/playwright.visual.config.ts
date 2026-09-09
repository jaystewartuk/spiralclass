import { defineConfig, devices } from "@playwright/test";

/**
 * Visual baseline sweep — a third Playwright project, alongside the happy-path
 * E2E suite (playwright.config.ts) and the a11y sweep
 * (playwright.a11y.config.ts).
 *
 * WHAT IT IS FOR. Two jobs that happen to need the same machinery. First, the
 * before-and-after record for the design re-architecture: the "before" cannot
 * be reconstructed once a token moves, so it is captured first and committed.
 * Second, ongoing visual-regression cover — once the new system lands, a
 * change to one token shows its blast radius across every screen before it
 * merges, which is the only way a design system with 99 consuming routes stays
 * honest.
 *
 * WHY IT IS A SEPARATE CONFIG. The E2E suite runs serially (workers: 1)
 * because it mutates booking and payment state, and it is the gate between a
 * commit and production — bolting ~1,200 screenshots onto it would make the
 * promote path unusably slow. This sweep is read-only and parallelises freely,
 * exactly like the a11y one, and for the same reasons.
 *
 * THE VIEWPORT MATRIX IS THE POINT, and it is chosen against
 * src/lib/breakpoints.ts (D-122) rather than against Tailwind's defaults,
 * which this app does not use:
 *
 *   390   iPhone 14 / the common phone. Below `roomy` (640).
 *   430   iPhone Pro Max. Still phone layout, but where long French labels
 *         start to fit and English ones look sparse.
 *   768   The tablet width that, under D-122, deliberately still gets the
 *         PHONE layout. The most contentious width in the product and the one
 *         a reviewer resizing the window will land on first.
 *   1280  TABLET_MAX_WIDTH — one pixel below DESKTOP_MIN_WIDTH. The boundary
 *         itself, where an off-by-one in a breakpoint shows up.
 *   1440  The `lg` layout, and what the E2E and a11y suites already pin to.
 *   1920  `2xl`. Currently zero components respond to it, which is itself
 *         worth photographing.
 *
 * EACH VIEWPORT RUNS IN BOTH THEMES. Dark mode is where the 107 raw palette
 * utilities fail — they have no `dark:` counterpart, so they render
 * light-on-light — and a light-only sweep would photograph none of it. Theme
 * is driven by `colorScheme`, which sets prefers-color-scheme; next-themes is
 * mounted with defaultTheme="system" and enableSystem, so the emulated
 * preference is enough and no storage seeding is needed.
 *
 * TARGET. A deployed environment by default, like the a11y sweep — every
 * authenticated route is server-rendered against a real database. Override
 * with VISUAL_BASE_URL for local or production.
 *
 *   pnpm test:visual                    # public tier, against preview
 *   VISUAL_BASE_URL=https://spiralclass.com pnpm test:visual
 *   VISUAL_TIER=all pnpm test:visual    # needs DATABASE_URL for the sessions
 *
 * RUNNING THE AUTHENTICATED TIERS AGAINST A LOCAL SERVER needs
 * `E2E_RATE_LIMIT_BYPASS=1` in the SERVER's environment — apps/web/.env.local,
 * not the Playwright process. The setup signs in three times and each retry
 * signs in again; without it the per-email OTP limiter silently leaves the form
 * on the email step and the run fails 30 seconds later waiting for a code input
 * that will never appear. Same reason tests/e2e/README.md asks for it. It is
 * read straight off process.env and defaults to false, so it cannot leak into
 * a deployment.
 */

const baseURL = process.env.VISUAL_BASE_URL ?? "https://preview.spiralclass.com";
const isCI = Boolean(process.env.CI);

type Viewport = { name: string; width: number; height: number };

/** Widths chosen against src/lib/breakpoints.ts — see the header. */
export const VIEWPORTS: Viewport[] = [
  { name: "390", width: 390, height: 844 },
  { name: "430", width: 430, height: 932 },
  { name: "768", width: 768, height: 1024 },
  { name: "1280", width: 1280, height: 900 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
];

export const THEMES = ["light", "dark"] as const;

export default defineConfig({
  testDir: "./tests/visual",
  // Only the capture spec runs under Playwright; manifest.test.ts is a vitest
  // unit test that happens to live in the same folder.
  // Capture specs only. The setup file is matched by the `setup` project's own
  // testMatch, which overrides this — broadening it here instead made every
  // capture project run the setup too, so three sign-ins became thirty-nine and
  // tripped the per-email OTP limiter.
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: isCI,
  // A local `next dev` is ONE process that compiles each route on first hit,
  // so the default worker count (one per core) does not make it faster — it
  // makes it time out. Twelve contexts hammering it produced 45s navigation
  // timeouts, ERR_EMPTY_RESPONSE, and contexts destroyed mid-settle; four
  // workers finish sooner than twelve that spend their time retrying. A
  // deployed target is a real server behind a proxy and takes the default.
  workers: baseURL.includes("127.0.0.1") || baseURL.includes("localhost") ? 4 : undefined,
  // A screenshot that differs because a font had not settled is a false
  // positive that costs more than a re-run.
  retries: 1,
  reporter: isCI ? [["html", { open: "never" }], ["list"]] : "list",
  // 99 routes at 12 combinations each is a long sweep; give the whole run room
  // without letting any single capture hang.
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL,
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    trace: "retain-on-failure",
    // The E2E and a11y suites pin es-MX because they assert Spanish copy. This
    // sweep pins `en` instead: the default locale is `en` (DEFAULT_LOCALE in
    // packages/shared/src/i18n/locales.ts), so English is what an unknown
    // visitor sees, and the baseline should photograph that. Text expansion in
    // Spanish and French is a separate concern, covered by re-running with
    // VISUAL_LOCALE rather than by mixing locales into one baseline.
    locale: process.env.VISUAL_LOCALE ?? "en-US",
    timezoneId: "America/Mexico_City",
  },

  projects: [
    // Signs in once per audience and saves the session. Every capture project
    // depends on it, so ~1,200 captures share three sign-ins rather than
    // driving the OTP form 1,200 times.
    // Pinned to es-MX because tests/e2e/_helpers/better-auth.ts locates the
    // sign-in fields by their Spanish labels (/correo/i, /código/i) — the E2E
    // suite it was written for pins the same locale. Reusing that helper
    // unchanged is worth more than an English sign-in: it is the path that is
    // already known to work around the raw-HTTP 500 documented there. The
    // setup strips the resulting `locale` cookie so the captures still render
    // in `en`, which is what this sweep is for.
    { name: "setup", testMatch: /auth\.setup\.ts/, use: { locale: "es-MX" } },
    ...VIEWPORTS.flatMap((viewport) =>
      THEMES.map((theme) => ({
        name: `${viewport.name}-${theme}`,
        dependencies: ["setup"],
        use: {
          ...devices["Desktop Chrome"],
          viewport: { width: viewport.width, height: viewport.height },
          // Phone widths get touch and a mobile UA so any coarse-pointer or
          // hover-capability media query resolves the way it would on a device,
          // not the way it resolves in a narrow desktop window.
          isMobile: viewport.width < 640,
          hasTouch: viewport.width < 640,
          colorScheme: theme,
        },
      })),
    ),
  ],
});
