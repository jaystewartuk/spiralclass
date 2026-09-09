import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

import { getPrisma } from "../e2e/_helpers/prisma";
import { SESSION_EMAILS, statePath } from "./session";

/**
 * Writes pictures of the authenticated surfaces nothing else in the repository
 * shows, for a person to look at.
 *
 * NOT a regression check. `class-detail` and the student surfaces are
 * `excluded: "live"` in `routes.ts` because they render whatever the seed
 * happens to hold, and a baseline that moves when a fixture does is one people
 * learn to ignore. This spec asserts that the page LOADED and then photographs
 * it; `regression.spec.ts` is the half that asserts pixels, and it stays scoped
 * to the public routes.
 *
 *   VISUAL_BASE_URL=http://localhost:3000 pnpm exec playwright test \
 *     --config playwright.visual.config.ts portfolio-shots --project=1280-light
 *
 * ⚠️ TWO THINGS THIS FILE EXISTS TO GET RIGHT, both learned the hard way.
 *
 * It applies a session explicitly. Without `test.use({ storageState })` the
 * project has none, every route bounces to /sign-in, and Playwright reports
 * four passes — because a screenshot of a redirect is still a successful
 * screenshot. `auth.setup.ts` documents the same failure costing a 1,167-test
 * sweep; this spec hit it on its first run. Hence the assertion below that the
 * URL did not bounce, before anything is captured.
 *
 * And it resolves ids from the DATABASE, not from the markup. Clicking "the
 * first row" couples a screenshot script to a page's DOM, which is the thing
 * most likely to change underneath it; the seed's uuids are regenerated every
 * run, so a literal would rot immediately. Asking Prisma is stable against both.
 *
 * ⚠️ Run it against a LOCAL, freshly seeded database only. Every person in a
 * capture from preview is real, under her real name — which is why
 * `docs/design/evidence/**` is gitignored.
 */

const OUT = join(process.cwd(), "..", "..", ".polish", "shots");

test.use({ storageState: statePath("teacher") });

test.describe("portfolio shots", () => {
  let studentId: string;
  let bookingId: string;

  test.beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });

    const prisma = getPrisma();
    const teacher = await prisma.teacher.findFirst({
      where: { email: SESSION_EMAILS.teacher },
      select: { id: true },
    });
    if (!teacher) throw new Error(`no seeded teacher for ${SESSION_EMAILS.teacher}`);

    // A class that HAS confirmed insights, and the student it belongs to.
    // `findFirst` with no ordering returned a different student on every run,
    // and often one whose Learning tab was empty — a screenshot of an empty
    // state that looks like a product bug rather than a fixture gap.
    const booking = await prisma.booking.findFirst({
      where: {
        teacherId: teacher.id,
        status: "completed",
        lessonInsights: { some: { confirmedAt: { not: null } } },
      },
      select: { id: true, studentId: true },
      orderBy: { scheduledStart: "desc" },
    });
    if (!booking) throw new Error("seed has no completed class with confirmed insights");
    studentId = booking.studentId;
    bookingId = booking.id;
  });

  /** Fails loudly if the session was not applied, rather than photographing /sign-in. */
  async function open(page: import("@playwright/test").Page, path: string) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    // Next's dev overlay floats over the bottom-left of every page and counts
    // Turbopack's own CSP `eval` violations as issues — a dev-mode HMR
    // artefact that does not exist in a production build. It is furniture, not
    // product, so it is hidden rather than photographed.
    await page
      .addStyleTag({ content: "nextjs-portal, [data-nextjs-toast] { display: none !important; }" })
      .catch(() => {});
    expect(
      new URL(page.url()).pathname,
      `${path} bounced to ${page.url()} — the teacher session is not being applied`,
    ).not.toMatch(/^\/sign-in/);
  }

  test("the teacher dashboard, populated", async ({ page }) => {
    await open(page, "/dashboard");
    await page.screenshot({ path: join(OUT, "dashboard.png"), fullPage: true });
  });

  test("a completed class — summary, insights, notes and homework", async ({ page }) => {
    await open(page, `/dashboard/classes/${bookingId}`);
    await page.screenshot({ path: join(OUT, "class-detail.png"), fullPage: true });
  });

  test("the student's record — focus areas across classes", async ({ page }) => {
    await open(page, `/dashboard/students/${studentId}`);
    await page.screenshot({ path: join(OUT, "student-detail.png"), fullPage: true });

    // The tabs are URL state, not a client widget (`?tab=`), so navigate rather
    // than click — a role-based click found nothing here, and a screenshot of
    // the page that did not change is indistinguishable from one that did.
    await open(page, `/dashboard/students/${studentId}?tab=learning`);
    await page.screenshot({ path: join(OUT, "student-learning.png"), fullPage: true });
  });

  test("the messages inbox", async ({ page }) => {
    await open(page, "/dashboard/messages");
    await page.screenshot({ path: join(OUT, "messages.png"), fullPage: true });
  });

  test("the library", async ({ page }) => {
    await open(page, "/dashboard/library");
    await page.screenshot({ path: join(OUT, "library.png"), fullPage: true });
  });
});
