import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { missingEnv } from "../e2e/_helpers/env";
import { getPrisma } from "../e2e/_helpers/prisma";
import { statePath, type AuthedTier } from "./session";
import { capturable, type ResolveKey, type Route, type Tier } from "./routes";

/**
 * Captures the visual baseline: every capturable route, at every viewport in
 * playwright.visual.config.ts, in both themes.
 *
 * TIERS. `VISUAL_TIER` selects what runs. The default is `public`, which needs
 * no database and no session and therefore works against any deployed URL —
 * including production, which is how the first "before" baseline was taken.
 * The authenticated tiers need a reachable Postgres and self-skip without one,
 * using the same guard the E2E suite uses, so a run without credentials
 * reports honestly rather than failing.
 *
 * Sessions come from the `setup` project (auth.setup.ts), which signs in once
 * per audience. Each tier's routes sit in their own describe block so
 * `test.use({ storageState })` can apply the right session — the alternative,
 * signing in per test, costs about eight seconds across ~1,200 captures.
 *
 * DETERMINISM is the whole difficulty with screenshot tests, and three things
 * cause nearly all of the noise here:
 *
 *   Animation. The landing page's CaptionsDemo replays on a timer, and
 *   tailwindcss-animate transitions run on mount. Playwright's
 *   `animations: "disabled"` freezes CSS animations and transitions at their
 *   end state; the JS-driven demo needs the extra settle below.
 *
 *   Fonts. Fraunces and Plus Jakarta Sans are self-hosted by next/font, but a
 *   capture that starts before they swap photographs the fallback stack, and
 *   the two have different metrics — so the same page produces two different
 *   images at random. document.fonts.ready is the fix.
 *
 *   Dates. Several screens render relative times ("in 3 days"), which change
 *   the image every day for no design reason. The clock is pinned.
 */

const TIER = (process.env.VISUAL_TIER ?? "public") as Tier | "all";
const LABEL = process.env.VISUAL_LABEL ?? "before";
const GALLERY = resolve(__dirname, "../../../..", "docs/design/gallery", LABEL);

/** A fixed instant, so relative-time copy renders identically on every run. */
const PINNED_NOW = new Date("2026-09-01T15:00:00.000Z");

const ORDERED_TIERS: Tier[] = ["public", "teacher", "student", "admin"];

/**
 * Freezes everything that would otherwise make two runs of the same page
 * produce two different images.
 */
async function settle(page: Page): Promise<void> {
  // Everything in here is cosmetic determinism, and a page that is still
  // navigating destroys the execution context out from under it. That is not a
  // reason to fail a capture — the screenshot below is the deliverable — so the
  // whole settle is best-effort.
  await page
    .addStyleTag({
      content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }
      /* The caret blinks, and lands in about a third of captures. */
      * { caret-color: transparent !important; }
    `,
    })
    .catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  // Lazy images and below-the-fold sections mount on intersection, so a
  // full-page screenshot taken without scrolling photographs empty placeholders.
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
  // Best-effort, and the timeout is the point. Several surfaces hold a
  // connection open for their whole life — chat, the notification poll, the
  // live-call bootstrap, PostHog — so they NEVER reach networkidle. Without an
  // explicit bound this inherits navigationTimeout (45s) and each of those
  // pages costs three quarters of a minute to learn something already known.
  // Across ~1,200 captures that is the difference between a twenty-minute
  // sweep and a two-hour one. Three seconds is enough for the requests that do
  // settle; the rest are handled by domcontentloaded and the scroll above.
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
}

/** Look up the seed value a parameterised route needs. Cached per worker. */
const resolved = new Map<ResolveKey, string | null>();

async function resolveParam(key: ResolveKey): Promise<string | null> {
  if (resolved.has(key)) return resolved.get(key) ?? null;
  const prisma = getPrisma();
  let value: string | null = null;
  switch (key) {
    case "bookingId":
      value = (await prisma.booking.findFirst({ select: { id: true } }))?.id ?? null;
      break;
    case "studentId":
    case "adminStudentId":
      value = (await prisma.student.findFirst({ select: { id: true } }))?.id ?? null;
      break;
    case "teacherId":
    case "adminTeacherId":
      value = (await prisma.teacher.findFirst({ select: { id: true } }))?.id ?? null;
      break;
    case "paymentId":
      value = (await prisma.payment.findFirst({ select: { id: true } }))?.id ?? null;
      break;
    case "packageId":
    case "adminPackageId":
      value = (await prisma.package.findFirst({ select: { id: true } }))?.id ?? null;
      break;
    case "assignmentId": {
      // Pin the class to this assignment's own booking. The student homework
      // page checks the two agree and 404s otherwise, so resolving them
      // independently would photograph a not-found page and call it green.
      const assignment = await prisma.assignment.findFirst({
        select: { id: true, bookingId: true },
      });
      value = assignment?.id ?? null;
      if (assignment) resolved.set("bookingId", assignment.bookingId);
      break;
    }
    case "activityId":
      // Marketing activities are generated per teacher on demand; the seed
      // creates none, so this route has nothing to photograph.
      value = null;
      break;
    case "helpAudience":
      value = "teacher";
      break;
    case "helpSlug":
      value = null; // Needs the help-content registry; not seeded.
      break;
  }
  resolved.set(key, value);
  return value;
}

function defineCapture(route: Route): void {
  test(`${route.name} — ${route.path}`, async ({ page }, testInfo) => {
    await page.clock.setFixedTime(PINNED_NOW);

    let path = route.path;
    if (route.resolve) {
      // Substituted by NAME, in the order listed: a route with two parameters
      // (the homework page) would otherwise have only its first placeholder
      // filled, since one blind replace can't tell them apart.
      for (const key of Array.isArray(route.resolve) ? route.resolve : [route.resolve]) {
        const value = await resolveParam(key);
        test.skip(
          value === null,
          `no seed row for ${key}; run \`pnpm seed\` against this database`,
        );
        path = path.replace(`:${key}`, value as string);
      }
    }

    await page.goto(path, { waitUntil: "domcontentloaded" });

    // Silence is not success. An authenticated route that bounced to sign-in
    // still screenshots cleanly, so without this the sweep reports green while
    // photographing the same redirect a thousand times — which is exactly what
    // the first run did. Fail where the cause is legible.
    if (route.tier !== "public") {
      const landed = new URL(page.url()).pathname;
      expect(
        landed,
        `${route.path} bounced to ${landed} — the ${route.tier} session is not being applied`,
      ).not.toMatch(/^\/(sign-in|sign-up)/);
    }

    await settle(page);

    const file = join(GALLERY, testInfo.project.name, `${route.name}.png`);
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true, animations: "disabled" });

    // A sidecar so the gallery builder can label each image without
    // re-deriving the manifest.
    writeFileSync(
      file.replace(/\.png$/, ".json"),
      JSON.stringify(
        {
          name: route.name,
          path,
          tier: route.tier,
          portfolio: route.portfolio ?? false,
          project: testInfo.project.name,
          capturedAt: new Date().toISOString(),
          baseURL: testInfo.project.use.baseURL,
        },
        null,
        2,
      ) + "\n",
    );
  });
}

for (const tier of ORDERED_TIERS) {
  const routes = capturable().filter(
    (route) => route.tier === tier && (TIER === "all" || TIER === tier),
  );
  if (routes.length === 0) continue;

  test.describe(`visual baseline — ${tier}`, () => {
    if (tier !== "public") {
      test.skip(
        missingEnv.length > 0,
        `the ${tier} tier needs a database: missing ${missingEnv.join(", ")}. ` +
          `The public tier runs without one — VISUAL_TIER=public.`,
      );
      test.use({ storageState: statePath(tier as AuthedTier) });
    }
    for (const route of routes) defineCapture(route);
  });
}
