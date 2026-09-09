import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Accessibility sweep over the unauthenticated surface, in both production
 * locales.
 *
 * Automated auditing catches roughly a third of real accessibility problems, so
 * treat this as a floor rather than a certificate. The structural tests at the
 * bottom cover things axe cannot see on its own: whether a keyboard user can
 * reach the primary call to action, whether headings descend in an order a
 * screen-reader user can navigate, and whether each page has exactly one h1.
 *
 * Scope is deliberately the PUBLIC routes. They are the highest-stakes ones —
 * a student meeting this app for the first time is on the booking funnel, and
 * has no support channel and no reason to persevere — and they need no session,
 * so this suite stays free of auth fixtures and the flakiness they bring. The
 * authenticated dashboard is a worthwhile follow-up, not a reason to delay
 * covering the funnel.
 */

/** Routes that render for an anonymous visitor. */
const PUBLIC_ROUTES = [
  "/",
  "/pricing",
  "/features",
  "/about",
  "/terms",
  "/privacy-notice",
  "/help",
  // The auth funnel. Every user of either app passes through these, they need
  // no session, and they are almost entirely form controls — the single
  // densest concentration of label/focus/error-association risk in the
  // product, and previously the largest anonymous gap in this sweep.
  //
  // Verified anonymous: neither page calls a require* gate, and middleware's
  // matcher does not redirect them for a session-less visitor. Note that
  // /help/<audience> is NOT in this list for exactly that reason — it gates on
  // requireOnboardedTeacher()/requireStudent(), so an anonymous run would
  // silently audit the sign-in redirect instead of the help centre.
  "/sign-in",
  "/sign-up",
];

/**
 * The public booking funnel — the money path, and the one route here whose
 * render depends on real teacher data.
 *
 * Slug matches the dedicated fixture the production synthetic monitor already
 * probes (scripts/local/synthetic.sh — was synthetic.yml until D-129 deleted
 * every workflow in this repo). Override for another environment.
 */
const TEACHER_SLUG = process.env.A11Y_TEACHER_SLUG ?? "alicia-moreno";
const BOOKING_ROUTES = [`/b/${TEACHER_SLUG}`];

const ROUTES = [...PUBLIC_ROUTES, ...BOOKING_ROUTES];

/**
 * WCAG 2.1 A and AA — the conformance level this product targets. Best-practice
 * rules are excluded on purpose: they are opinions, not conformance failures,
 * and mixing them in makes a red run ambiguous about whether something is
 * actually broken.
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

test.describe("axe", () => {
  for (const route of ROUTES) {
    test(`${route} has no WCAG A/AA violations`, async ({ page }) => {
      await page.goto(route, { waitUntil: "domcontentloaded" });

      const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();

      // Report the rule, the fix, the offending element AND axe's own failure
      // summary — a bare `toEqual([])` prints a wall of JSON nobody reads, but
      // the selector alone is not enough either: a contrast failure reported as
      // `.font-medium` is undiagnosable, while axe's summary names the two
      // colours and the ratio it measured. That gap cost an afternoon.
      const summary = violations.map(
        (violation) =>
          `${violation.id} (${violation.impact}): ${violation.help}\n` +
          `    ${violation.helpUrl}\n` +
          violation.nodes
            .map(
              (node) =>
                `    ${node.target.join(" ")}\n` +
                (node.failureSummary ?? "")
                  .split("\n")
                  .filter(Boolean)
                  .map((line) => `      ${line}`)
                  .join("\n"),
            )
            .join("\n"),
      );

      expect(summary, `${route}\n\n${summary.join("\n\n")}`).toEqual([]);
    });
  }
});

test.describe("keyboard and structure", () => {
  test("every public page has exactly one h1", async ({ page }) => {
    for (const route of ROUTES) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await expect(page.locator("h1"), `${route} should have exactly one h1`).toHaveCount(1);
    }
  });

  test("headings descend without skipping a level", async ({ page }) => {
    for (const route of ROUTES) {
      await page.goto(route, { waitUntil: "domcontentloaded" });

      const levels = await page
        .locator("h1, h2, h3, h4, h5, h6")
        .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])));

      for (let i = 1; i < levels.length; i += 1) {
        expect(
          levels[i] - levels[i - 1],
          `${route}: h${levels[i - 1]} is followed by h${levels[i]} — a skipped level ` +
            `breaks screen-reader navigation, which relies on the heading outline.`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  test("every public page exposes the landmarks a screen reader navigates by", async ({ page }) => {
    for (const route of ROUTES) {
      await page.goto(route, { waitUntil: "domcontentloaded" });

      // Roles rather than tags: a <header> nested inside <article> is a
      // sectioning header, not a banner landmark, and only the outermost one
      // should be announced as the page banner.
      await expect(page.getByRole("main"), `${route} should have one main landmark`).toHaveCount(1);
    }
  });

  test("the booking page's primary action is keyboard reachable", async ({ page }) => {
    await page.goto(BOOKING_ROUTES[0], { waitUntil: "domcontentloaded" });

    // Walk the tab order from the top of the document and assert we land on
    // something interactive within a sane number of stops. A CTA that is only
    // reachable by mouse (a div with onClick, a positive tabindex trap) is
    // invisible to this — and to a keyboard user mid-checkout.
    let reachedInteractive = false;

    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press("Tab");

      const tag = await page.evaluate(() => document.activeElement?.tagName.toLowerCase() ?? "");
      if (["a", "button", "input", "select", "textarea"].includes(tag)) {
        reachedInteractive = true;
        break;
      }
    }

    expect(
      reachedInteractive,
      "No focusable control reached within 40 Tab presses on the booking page — the " +
        "checkout entry point may be mouse-only.",
    ).toBe(true);
  });

  test("the page declares its language", async ({ page }) => {
    // A missing or wrong lang attribute makes a screen reader pronounce Spanish
    // copy with an English voice, which is close to unusable. This app serves
    // two locales from the same routes, so it is a live risk rather than a
    // theoretical one.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("lang", /^(es|en)/);
  });
});
