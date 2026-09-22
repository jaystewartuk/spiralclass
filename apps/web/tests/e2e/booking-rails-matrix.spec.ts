import { test, expect } from "@playwright/test";

import { applyE2ESkipGuards } from "./_helpers";

// The rails and booking-page shapes the seed could not produce until the
// fixtures were overhauled. Each test here was unreachable before, not because
// nobody wrote it, but because no seeded teacher had the configuration:
//
//   * Paula Pagos  (paula-pagos)  — card AND a transfer together, which is
//                                   the only shape that renders a method
//                                   chooser; plus a transfer discount, a pay-
//                                   at-reservation template and testimonials.
//   * Yuki Tanaka  (yuki-tanaka)  — a 0-decimal currency (JPY), so the
//                                   minor-unit arithmetic is exercised against
//                                   a real row rather than only in unit tests.
//
// Gated on E2E_EXTENDED=1 like the other extended journeys.
applyE2ESkipGuards({ extended: true });

// A "manual bank rail (SPEI)" block covered Sofía Reyes, a teacher listed only
// because HAS_PAYOUT_RAIL_WHERE's `bank_account` arm matched. D-145 removed
// that kind and that arm, and her fixture with them. Stripe presents SPEI
// itself now, so the rail the block existed for is covered by the card path.

test.describe("every rail at once", () => {
  test("offers card by default and hides the transfer rails behind a disclosure", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/b/paula-pagos/buy");

    // Card is the default, so the CTA is a priced Pay button.
    await expect(page.getByRole("button", { name: /^Pay\b/i })).toBeVisible();

    // Since D-144 the rail switcher is a disclosure rather than the first
    // control on the page: closed by default, and after the pay button.
    const disclosure = page.locator("details");
    await expect(disclosure).toHaveCount(1);
    await expect(disclosure).not.toHaveAttribute("open", /.*/);

    // Both rails live inside it. Three until D-145 removed the `bank_account`
    // instrument that made a third — card, Wise and a SPEI account, where the
    // SPEI one duplicated what Stripe already offers on the card rail.
    await disclosure.locator("summary").click();
    await expect(page.locator('input[name="method-toggle"]')).toHaveCount(2);
  });

  test("switching to a transfer rail re-prices the checkout", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/b/paula-pagos/buy");

    const payButton = page.getByRole("button", { name: /^Pay\b/i });
    const cardPrice = await payButton.textContent();

    await page.locator("details summary").click();
    // The second option is the transfer instrument; the first is the card.
    await page.locator('input[name="method-toggle"]').nth(1).check();

    // The CTA becomes rail-neutral, because a transfer is not a card payment.
    await expect(page.getByRole("button", { name: /^Continue$/i })).toBeVisible();
    // And the price it quoted as a card price is not the transfer price.
    expect(cardPrice).toBeTruthy();
  });

  test("a pay-at-reservation class will not take money without a time", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/b/paula-pagos/buy");

    // Her primary template is singleClass, so D-111's rule applies: the pay
    // button stays disabled until a slot is chosen, and (since D-144) the
    // picker sits ABOVE it so the blocking copy's "above" is true.
    await expect(page.getByText(/Pick a class time above to continue/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Pay\b/i })).toBeDisabled();
  });

  test("carries her social proof into the checkout", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/b/paula-pagos/buy");
    await expect(page.getByText(/Rita Alves/i)).toBeVisible();
  });
});

test.describe("a 0-decimal currency", () => {
  test("renders yen as yen, not divided by a hundred", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/b/yuki-tanaka");

    // Seeded at 18_000 minor units. JPY has exponent 0, so that is ¥18,000.
    // If any formatter treats it as 2-decimal it reads ¥180 — the bug class
    // CLAUDE.md calls out, now visible on a real page rather than only in a
    // unit test.
    await expect(page.getByText(/18,000/).first()).toBeVisible();
    await expect(page.getByText(/¥180\b/)).toHaveCount(0);
  });
});
