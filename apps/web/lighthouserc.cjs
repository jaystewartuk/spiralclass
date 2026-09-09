/**
 * Lighthouse CI budgets for the public surface.
 *
 * TARGET: a deployed environment. Unlike a static site, every route here is
 * server-rendered against a real database, so there is no `dist/` to point
 * Lighthouse at — `staticDistDir` is not an option. Defaults to preview; set
 * LHCI_BASE_URL to aim it elsewhere.
 *
 * ON THE NUMBERS BELOW — read before treating a warning as noise.
 *
 * The category scores are `warn`, not `error`, and that is a deliberate
 * starting state rather than a permanent one. A budget is only meaningful if it
 * was derived from a measurement: set it too low and it certifies nothing, set
 * it too high and the first honest run is red for reasons nobody has time to
 * fix, and the job gets muted. Neither failure is worth inheriting from a
 * number someone guessed.
 *
 * So the intended sequence is:
 *   1. Run this once against preview and read `.lighthouseci/`.
 *   2. Replace each `minScore` below with (measured − ~0.03) and flip the
 *      assertion from "warn" to "error".
 *   3. Ratchet upward from there, never down — the same discipline as the
 *      coverage floor in vitest.config.ts.
 *
 * The assertions that ARE hard errors are the ones that do not depend on how
 * fast the app happens to be on a given runner: a page either declares a
 * language or it does not. Those can be enforced from day one without a
 * measurement, and they are the ones that silently regress.
 */

const baseUrl = (process.env.LHCI_BASE_URL ?? "https://preview.spiralclass.com").replace(/\/$/, "");

/** Public routes worth a performance budget. */
const paths = [
  "/",
  "/precios",
  "/features",
  `/b/${process.env.LHCI_TEACHER_SLUG ?? "alicia-moreno"}`,
];

module.exports = {
  ci: {
    collect: {
      url: paths.map((path) => `${baseUrl}${path}`),
      // Three runs and take the median — a single Lighthouse run on a shared CI
      // runner varies by several points on noise alone, which is enough to make
      // a tight budget flap.
      numberOfRuns: 3,
      settings: {
        preset: "desktop",
        chromeFlags: "--no-sandbox --headless=new",
      },
    },

    assert: {
      assertions: {
        /* ---- Hard errors: measurement-independent correctness ---- */

        // A page with no <title> or no lang is broken for screen readers and
        // search engines regardless of how fast it loads.
        "document-title": "error",
        "html-has-lang": "error",
        viewport: "error",

        /* ---- Warnings: ratchet these to `error` after the first real run ---- */

        "categories:performance": ["warn", { minScore: 0.7 }],
        "categories:accessibility": ["warn", { minScore: 0.9 }],
        "categories:best-practices": ["warn", { minScore: 0.9 }],
        "categories:seo": ["warn", { minScore: 0.9 }],

        // Generous, and intentionally so — this is a React app with a client
        // runtime, not a zero-JS static site. The point of the number is to
        // catch a step change (an accidental barrel import pulling in a chart
        // library on the landing page), not to police normal growth.
        "total-byte-weight": ["warn", { maxNumericValue: 2_000_000 }],
        "unused-javascript": ["warn", { maxNumericValue: 500_000 }],

        /* ---- Off, with reasons ---- */

        // Preview deliberately serves a noindex header (the
        // NEXT_PUBLIC_DEPLOY_ENV-keyed rule), so this audit fails by design on
        // the default target. Turn it on if pointing at production.
        "is-crawlable": "off",
        // Accessibility is asserted properly by the axe suite
        // (tests/a11y/public-routes.spec.ts), which checks WCAG A/AA across
        // both locales. Lighthouse's subset here would only duplicate that
        // signal at lower resolution and split the source of truth.
        "color-contrast": "off",
        // Third-party embeds (PostHog, Sentry) own these and this repo cannot
        // fix them.
        "third-party-cookies": "off",
        "csp-xss": "off",
      },
    },

    upload: {
      target: "filesystem",
      outputDir: ".lighthouseci",
    },
  },
};
