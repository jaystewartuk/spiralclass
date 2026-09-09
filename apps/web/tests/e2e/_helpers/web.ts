import { expect, type Locator, type Page } from "@playwright/test";

// Abort any navigation to the Stripe Checkout stub / hosted checkout. The web
// purchase flow redirects there after the action mints the session; the E2E
// then flips the payment row directly instead of completing a real checkout.
// Browser-only helper (takes a Playwright Page) — kept out of api.ts so the
// non-browser specs don't pull a browser type they never use.
export async function blockCheckoutStub(page: Page): Promise<void> {
  await page.route(/stub\.stripe|checkout\.stripe\.com/, (route) => route.abort("aborted"));
}

// Click a client <Link> and wait for the SPA navigation to actually take.
// Next.js client links preventDefault on click, then router.push once React has
// hydrated — a click that lands during hydration is swallowed (the handler runs
// but router.push isn't wired yet), leaving the URL unchanged. A single
// click-then-assert would then burn the full URL timeout on a no-op click and
// flake. Retry the click-then-assert until the nav lands. Use ONLY for
// navigation links (idempotent) — never for mutating submit buttons, where a
// re-click could double-submit.
//
// Two distinct failure modes hide behind a stalled URL, and the timeouts below
// account for both:
//   1. Pre-hydration *swallow* — the handler is attached but router.push isn't
//      wired yet, so the click is a no-op and the URL never changes no matter
//      how long we wait. The only cure is to re-click after hydration.
//   2. Pre-hydration *full navigation* — the handler isn't attached yet, so the
//      click falls through to the bare <a>'s default browser navigation. Under
//      `next dev` the target route compiles on first hit (6–15s on a CI runner;
//      /book was measured at 14.5s), and the browser URL only commits once
//      that cold compile finishes. A route no earlier test warmed (e.g.
//      /reschedule) is always cold on first hit here.
// `attemptTimeout` must therefore outlast a cold compile, or each attempt would
// expire mid-navigation and the retry would re-click — interrupting and
// restarting the compile, thrashing until the outer timeout (this is exactly
// how the reschedule journey hard-failed). The guard below also skips the
// re-click once a navigation has already landed, and swallows the click error
// from racing a tearing-down page, so a slow full nav is never interrupted.
export async function clickLinkUntilNavigated(
  page: Page,
  link: Locator,
  urlPattern: RegExp,
  opts: { timeout?: number; attemptTimeout?: number } = {},
): Promise<void> {
  const { timeout = 60_000, attemptTimeout = 20_000 } = opts;
  await expect(link).toBeVisible();
  await expect(async () => {
    // A prior attempt's full-page navigation can commit late; if the URL has
    // already landed, don't click again (the link is gone on the new page).
    if (urlPattern.test(page.url())) return;
    // The click may race a page that's mid-navigation from a prior attempt's
    // full nav (detached element). Ignore that and let toHaveURL adjudicate.
    await link.click().catch(() => undefined);
    await expect(page).toHaveURL(urlPattern, { timeout: attemptTimeout });
  }).toPass({ timeout });
}
