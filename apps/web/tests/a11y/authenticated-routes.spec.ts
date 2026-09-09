import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { missingEnv } from "../e2e/_helpers/env";
import { capturable, type Route } from "../visual/routes";
import { statePath, type AuthedTier } from "../visual/session";

/**
 * Accessibility sweep over the SIGNED-IN product.
 *
 * The public sweep next door covers nine routes and says, in its own header,
 * that the authenticated dashboard is "a worthwhile follow-up, not a reason to
 * delay covering the funnel". This is that follow-up, and D-140 is why it stops
 * being optional: a design system whose governing constraint is legibility
 * cannot leave the surfaces people work in all day unmeasured.
 *
 * It reuses the visual sweep's route manifest and its saved sessions rather than
 * keeping a second list — a route added to one is covered by both, and there is
 * no second thing to forget to update.
 *
 * Scope: the portfolio-tier authenticated routes. Not every one of the 86,
 * because axe is slow and a sweep nobody waits for is a sweep nobody runs; the
 * screens chosen are the ones a teacher and a student are actually in every
 * day.
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/** The signed-in screens people spend their time in. */
const TIERS: AuthedTier[] = ["teacher", "student"];

const ROUTES: Route[] = TIERS.flatMap((tier) =>
  capturable(tier).filter((route) => route.portfolio && !route.path.includes(":")),
);

test.describe("axe — signed in", () => {
  test.skip(
    missingEnv.length > 0,
    `authenticated a11y needs a database: missing ${missingEnv.join(", ")}`,
  );

  for (const route of ROUTES) {
    test(`${route.path} has no WCAG A/AA violations`, async ({ browser }) => {
      // A fresh context per route, carrying that tier's saved session. The
      // public sweep can share one; these cannot, because a teacher and a
      // student must not share cookies.
      const context = await browser.newContext({
        storageState: statePath(route.tier as AuthedTier),
      });
      const page = await context.newPage();
      try {
        await page.goto(route.path, { waitUntil: "domcontentloaded" });

        // A redirect to sign-in would scan the sign-in page and pass, which is
        // the same silent-green failure the visual sweep hit. Fail loudly.
        expect(
          new URL(page.url()).pathname,
          `${route.path} bounced to sign-in — the ${route.tier} session is not applied`,
        ).not.toMatch(/^\/(sign-in|sign-up)/);

        const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
        const summary = violations.map(
          (violation) =>
            `${violation.id} (${violation.impact}): ${violation.help}\n` +
            `    ${violation.helpUrl}\n` +
            // Axe's own failure summary as well as the selector: a contrast
            // failure reported as `.font-medium` names no colours and cannot
            // be acted on.
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
        expect(summary, `${route.path}\n\n${summary.join("\n\n")}`).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});
