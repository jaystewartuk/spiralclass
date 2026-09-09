import { test, expect, type Page } from "@playwright/test";

import { applyE2ESkipGuards, signInAsViaOtp } from "./_helpers";

// Extended E2E: the seed's subscription matrix + payment-rail edge cases, so
// the promote-to-production gate catches regressions in the monetization and
// checkout surfaces that the single happy path (a Stripe-ready, comped teacher)
// never touches. Exercises the seeded "hero" teachers (apps/web/scripts/seed.ts):
//
//   * Inés Navarro  (ines-navarro)  — Wise-only public checkout
//   * Fernando Cruz (fernando-cruz) — no payment rail yet + Pro trial banner
//   * Hugo Ramírez  (hugo-ramirez)  — past_due "update payment" banner
//   * Gabriela Reyes (gabriela-reyes) — Free over-cap teacher is not locked out
//
// Gated on E2E_EXTENDED=1 (the e2e.yml gate sets it), like the other extended
// journeys: runs in the promote gate + manual dispatch, self-skips on an ad-hoc
// local `pnpm test:e2e`.

applyE2ESkipGuards({ extended: true });

async function signInTeacher(page: Page, email: string) {
  await signInAsViaOtp(page, email, "/dashboard");
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
}

test.describe("payment rails (public checkout)", () => {
  test("Wise-only teacher offers Wise and no Stripe card", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/b/ines-navarro/buy");

    await expect(page.getByRole("heading", { name: /Inés Navarro/i })).toBeVisible();

    // The only rail is a manual transfer, so the CTA is the rail-neutral
    // "Continue" (the checkout copy is hardcoded English regardless of locale)
    // and there is no Stripe "Pay <price>" button at all.
    await expect(page.getByRole("button", { name: /^Continue$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Pay\b/i })).toHaveCount(0);
  });

  test("teacher with no rail is not publicly listed", async ({ page }) => {
    test.setTimeout(120_000);
    // Brand-new teacher mid-trial who hasn't connected a payment rail yet.
    // isPubliclyListed() (D-104) requires hasPayoutMethod, so a no-rail
    // teacher's public page renders Next's not-found UI rather than the old
    // "no online payment" notice — that notice-based behavior was removed by
    // the D-104 activation-model gate; there is no in-between "listed but
    // can't pay" state anymore. (The response status is still 200 here —
    // this build doesn't propagate notFound() to a real 404 status — so the
    // check is content-based, not status-based.)
    await page.goto("/b/fernando-cruz/buy");
    await expect(
      page.getByRole("heading", { name: /Página no encontrada|Page not found/i }),
    ).toBeVisible();
  });
});

test.describe("subscription banners (teacher app)", () => {
  test("past_due teacher sees the 'update payment' banner", async ({ page }) => {
    test.setTimeout(120_000);
    await signInTeacher(page, "profe.pastdue@spiralclass.com");
    await expect(page.getByText(/Tu último pago falló/i)).toBeVisible();
  });

  test("trialing teacher sees the 'Pro trial' banner", async ({ page }) => {
    test.setTimeout(120_000);
    await signInTeacher(page, "profe.trial@spiralclass.com");
    await expect(page.getByText(/prueba gratis de Pro/i)).toBeVisible();
  });

  test("Free over-cap teacher is not locked out of the dashboard", async ({ page }) => {
    test.setTimeout(120_000);
    // Gabriela is over both Free caps (4 students, 2 templates) — the product
    // rule is "never lock out": her dashboard still loads.
    await signInTeacher(page, "profe.free@spiralclass.com");
    await expect(page.getByRole("heading", { name: /Hola/i })).toBeVisible();
  });

  test("trial banner is hidden on the onboarding flow", async ({ page }) => {
    test.setTimeout(120_000);
    // Onboarding has its own focused stepper layout with no app chrome — same
    // guard AppNav already applies (pathname.startsWith("/onboarding")), now
    // also applied to the trial/past_due banner. The trialing
    // seed teacher has already completed onboarding, so revisiting an
    // onboarding step directly is a valid way to exercise the guard while
    // still trialing.
    await signInTeacher(page, "profe.trial@spiralclass.com");
    await expect(page.getByText(/prueba gratis de Pro/i)).toBeVisible();

    await page.goto("/onboarding/timezone");
    await expect(page.getByText(/prueba gratis de Pro/i)).toHaveCount(0);
  });
});
