import { expect, test } from "@playwright/test";
import { capturable } from "./routes";

/**
 * Visual regression on the portfolio surfaces.
 *
 * Distinct from capture.spec.ts, which WRITES a gallery for a person to look
 * at. This one asserts: a committed baseline exists, and the page still matches
 * it. A token change shows its blast radius here before it merges, which is the
 * only way a design system with 98 consuming routes stays honest.
 *
 * Scoped to the PUBLIC portfolio routes on purpose. Every authenticated screen
 * renders seeded data — a booking date, a balance, a class time — so its
 * pixels legitimately change when the seed does, and a baseline that fails for
 * an honest reason is one people learn to ignore.
 *
 * The clock is pinned and animations disabled for the same reason.
 *
 * ASSERTING is what the gate does, inside scripts/ci/e2e.sh, against a seeded
 * database and a production build that script boots itself.
 *
 * REGENERATING has to use the same stack, and the way to do that is:
 *
 *   VISUAL_UPDATE_SNAPSHOTS=booking bash scripts/ci/e2e.sh
 *
 * where the value is a filter on the route names you actually changed (`all`
 * rewrites everything, which you rarely want — see the script for why).
 *
 * NOT `pnpm test:visual:regression --update-snapshots`, which this comment
 * recommended until it was found to be a trap: playwright.visual.config.ts
 * defaults `baseURL` to https://preview.spiralclass.com, so that command
 * photographs whatever is DEPLOYED — not your working copy. It succeeds, writes
 * baselines of the old code, and the next gate run fails against them for
 * reasons that look nothing like the cause. Point VISUAL_BASE_URL at a local
 * server if you want to drive Playwright directly.
 *
 * Then LOOK at the images. `git status` should name only the routes you
 * changed; a route you did not touch appearing in that list is the finding.
 *
 * ONE MORE TRAP, which the `maxDiffPixelRatio` below cuts both ways on. The
 * tolerance exists for font rasterisation and cannot tell a pixel of
 * antialiasing from a real edit smaller than itself, so:
 *
 *   - a genuine change under the threshold PASSES, which means Playwright's
 *     default "changed" update mode writes nothing and the baseline silently
 *     keeps showing a layout that no longer ships (three regeneration runs in a
 *     row did nothing during the D-144 work before this was spotted); and
 *   - forcing `=all` to get around that rewrites every route, because the same
 *     sub-tolerance noise differs run to run — re-baselining ~130 images onto
 *     one machine's font rendering and burying the files you meant to change.
 *
 * Hence the scoped regeneration above: `=all` for the routes you touched, and
 * nothing else touched at all.
 */

const PINNED_NOW = new Date("2026-09-01T15:00:00.000Z");
const ROUTES = capturable("public").filter((route) => route.portfolio);

test.describe("visual regression", () => {
  for (const route of ROUTES) {
    test(`${route.name} matches its baseline`, async ({ page }) => {
      await page.clock.setFixedTime(PINNED_NOW);
      await page.goto(route.path, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.fonts.ready).catch(() => {});
      // Lazy sections mount on intersection; an unscrolled full-page shot
      // photographs empty placeholders and diffs against itself forever.
      await page
        .evaluate(async () => {
          const step = window.innerHeight;
          for (let y = 0; y < document.body.scrollHeight; y += step) {
            window.scrollTo(0, y);
            await new Promise((r) => requestAnimationFrame(() => r(null)));
          }
          window.scrollTo(0, 0);
        })
        .catch(() => {});
      await expect(page).toHaveScreenshot(`${route.name}.png`, {
        fullPage: true,
        animations: "disabled",
        // A hair of tolerance: font rasterisation differs by a pixel or two
        // between machines, and a suite that cries wolf gets muted.
        maxDiffPixelRatio: 0.01,
      });
    });
  }
});
