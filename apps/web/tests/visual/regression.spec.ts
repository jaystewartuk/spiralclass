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
 * database and a production build that script boots itself — on Linux only,
 * for the reason in the skip below.
 *
 * REGENERATING has to use the same stack, and since [D-171] it also has to use
 * the same machine, so it is a dispatch rather than a local command:
 *
 *   gh workflow run heavy.yml -f update_visual_baselines=booking --ref <branch>
 *
 * where the value is a filter on the route names you actually changed (`all`
 * rewrites everything, which you rarely want — see scripts/ci/e2e.sh for why).
 * That workflow's header has the download step; e2e.sh refuses to regenerate
 * anywhere else rather than quietly writing macOS pixels into a Linux set.
 *
 * NOT `pnpm test:visual:regression --update-snapshots`, which this comment
 * recommended until it was found to be a trap: playwright.visual.config.ts
 * defaults `baseURL` to https://preview.spiralclass.com, so that command
 * photographs whatever is DEPLOYED — not your working copy. It succeeds, writes
 * baselines of the old code, and the next gate run fails against them for
 * reasons that look nothing like the cause. Point VISUAL_BASE_URL at a local
 * server if you want to drive Playwright directly.
 *
 * TO SEE YOUR CHANGE ON THIS MACHINE — which is what the laptop gave up when
 * its own baseline set went — use capture.spec.ts. It WRITES a gallery instead
 * of asserting against one, so it needs no committed image and is bound to no
 * platform.
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
  /**
   * ONE baseline set, belonging to the machine that gates the merge ([D-171]).
   *
   * Playwright suffixes a snapshot with `process.platform`, so this suite used
   * to commit every capture twice — `-darwin.png` for the laptop, `-linux.png`
   * for `ubuntu-latest` ([D-161]). [D-162] then took the laptop out of the
   * release path altogether: `pnpm promote` reads the runners' verdict for the
   * exact commit it ships, so nothing that reaches production depends on the
   * macOS set. What was left of it was the bookkeeping D-161 predicted —
   * restyle a page, regenerate one set, and the other machine goes red on
   * exactly the routes you just fixed.
   *
   * So the assertion runs where the images were made, and skips out loud
   * everywhere else. This is not a softened check: heavy.yml runs this leg on
   * every pull request and every push to `main`, which is earlier than the
   * laptop ever ran it.
   *
   * ⚠️ Do NOT "fix" the skip by widening `maxDiffPixelRatio` until macOS and
   * Linux rasterisation both fit inside it. D-161 rejected that and the reason
   * is unchanged: the tolerance already cannot see two lines of grey text
   * swapping places, and one that spans two font stacks is decorative.
   */
  test.skip(
    process.platform !== "linux",
    `The visual baselines are -linux.png and are asserted on ubuntu-latest only (D-171); ` +
      `this machine is ${process.platform}. To see how a page renders here, run ` +
      `capture.spec.ts — it writes a gallery rather than asserting against one.`,
  );

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
