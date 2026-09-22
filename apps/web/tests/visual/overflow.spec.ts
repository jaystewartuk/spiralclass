import { expect, test } from "@playwright/test";
import { capturable } from "./routes";

/**
 * No page may scroll sideways.
 *
 * WHY THIS IS NOT COVERED BY regression.spec.ts, which photographs the same
 * routes at the same six widths. A full-page screenshot is taken at the
 * DOCUMENT's width, not the viewport's, so a page that overflows is
 * photographed at its overflowing width and the image matches its baseline
 * forever. That is not hypothetical: the committed 390px and 430px baselines
 * for the teacher dashboard were both 539px wide — a 149px overflow, on the
 * product's most-used screen, sitting in a green suite whose whole job is to
 * notice when a screen changes shape.
 *
 * The mechanism is worth stating, because it is invisible at the call site and
 * this is the only test that can see it. A grid track sized `auto` — which is
 * what `grid` with no unprefixed `grid-cols-*` gives you, i.e. every
 * `grid gap-6 lg:grid-cols-3` in this codebase below `lg` — is floored by its
 * item's MIN-CONTENT width. `truncate` is `white-space: nowrap`, so a line's
 * min-content is the width of the whole unwrapped string. One long student
 * name inside a card inside such a grid therefore does not truncate: it widens
 * the column, the card, and the document. `min-w-0` on the grid item is what
 * lowers that floor and lets the truncation happen. (Tailwind's
 * `grid-cols-<n>` utilities are immune — they compile to
 * `repeat(n, minmax(0, 1fr))`, which has no min-content floor.)
 *
 * Asserted at every viewport and in both themes, because a `dark:` or a
 * breakpoint-prefixed utility can widen a line at one combination and not
 * another.
 *
 * Scoped to the same routes the baselines cover — public and portfolio — so it
 * needs no session and no seeded row. /demo is the teacher dashboard: it
 * renders the real <DashboardView> from a fixture (D-142), which is why this
 * suite can guard the product's busiest authenticated screen without signing
 * in.
 */

/** Matches regression.spec.ts and the /demo page's own pinned clock, so a
 * relative date ("in 3 days") can't change a line's width between runs. */
const PINNED_NOW = new Date("2026-09-01T15:00:00.000Z");

const ROUTES = capturable("public").filter((route) => route.portfolio);

/** One rounded pixel of slack: `scrollWidth` is an integer, and a sub-pixel
 * layout (a 0.5px border, a fractional grid gap) legitimately rounds up. */
const SLACK_PX = 1;

test.describe("horizontal overflow", () => {
  for (const route of ROUTES) {
    test(`${route.name} fits its viewport`, async ({ page }) => {
      await page.clock.setFixedTime(PINNED_NOW);
      await page.goto(route.path, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.fonts.ready).catch(() => {});
      // Lazy sections mount on intersection, and a section that has not
      // mounted cannot overflow. Same scroll pass the baseline capture makes.
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

      const result = await page.evaluate(() => {
        const doc = document.documentElement;
        const limit = doc.clientWidth;
        // The SHALLOWEST elements that stick out. A deep one is almost always
        // a child stretched by its parent, so naming the ancestors is what
        // points at the element actually responsible.
        const culprits = [...document.querySelectorAll("body *")]
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > 0 && rect.right > limit + 1)
          .map(({ el, rect }) => {
            let depth = 0;
            for (let n = el.parentElement; n; n = n.parentElement) depth++;
            const cls = typeof el.className === "string" ? el.className : "";
            return {
              depth,
              label: `${el.tagName.toLowerCase()}${cls ? "." + cls.trim().split(/\s+/).join(".") : ""}`,
              right: Math.round(rect.right),
            };
          })
          .sort((a, b) => a.depth - b.depth)
          .slice(0, 3)
          .map((c) => `      ${c.label} (right edge ${c.right}px)`);
        return { scrollWidth: doc.scrollWidth, clientWidth: limit, culprits };
      });

      expect(
        result.scrollWidth,
        `${route.path} scrolls sideways: the document is ${result.scrollWidth}px in a ` +
          `${result.clientWidth}px viewport. Widest elements, outermost first:\n` +
          `${result.culprits.join("\n") || "      (none — check for a fixed width or a negative margin)"}\n` +
          `    An element inside a single-column grid usually needs \`min-w-0\` on the grid ITEM; ` +
          `see this file's header for why.`,
      ).toBeLessThanOrEqual(result.clientWidth + SLACK_PX);
    });
  }
});

/**
 * The same invariant, under a name long enough to prove it.
 *
 * SCOPED TO THE DASHBOARD, and to a mutation rather than the fixture, because
 * the fixture's names are short: "Mariana Duarte" fits, so the page above
 * passes even with the guard removed, and a guard that cannot fail is a file.
 * Lengthening a name in the /demo fixture instead would repaint all twelve
 * committed baselines for that route to test one of them.
 *
 * WHAT IT ASSERTS. Every line the design marked as truncating — computed
 * `text-overflow: ellipsis` — must actually truncate when its text outgrows
 * its column, rather than widening the page. That is the property `min-w-0` on
 * the dashboard's grid columns buys, and the one whose absence shipped a 539px
 * document to a 390px phone. Restoring the text afterwards keeps the page
 * intact for anything that follows.
 */
test.describe("truncation holds the line", () => {
  test("a very long student name truncates instead of widening the page", async ({ page }) => {
    await page.clock.setFixedTime(PINNED_NOW);
    await page.goto("/demo", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.fonts.ready).catch(() => {});

    const result = await page.evaluate(() => {
      const truncating = [...document.querySelectorAll("main *")].filter(
        (el) => getComputedStyle(el).textOverflow === "ellipsis",
      );
      const original = truncating.map((el) => el.innerHTML);
      // Long, and every bit of it a plausible name — the failure this catches
      // is a plausible full name, not a synthetic edge case.
      for (const el of truncating) el.textContent = "Anastasia Quintanilla-Berenguer Ávila";
      const doc = document.documentElement;
      const measured = { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
      truncating.forEach((el, i) => (el.innerHTML = original[i]));
      return { ...measured, count: truncating.length };
    });

    // A page with nothing marked truncating would pass vacuously.
    expect(result.count).toBeGreaterThan(0);
    expect(
      result.scrollWidth,
      `A long student name widened the dashboard to ${result.scrollWidth}px in a ` +
        `${result.clientWidth}px viewport instead of being ellipsised. The grid ` +
        `columns in components/dashboard/dashboard-view.tsx need \`min-w-0\`; see ` +
        `this file's header for the mechanism.`,
    ).toBeLessThanOrEqual(result.clientWidth + SLACK_PX);
  });
});
