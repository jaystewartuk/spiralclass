import { expect, test } from "@playwright/test";

import { applyE2ESkipGuards, signInAsViaOtp } from "./_helpers";

applyE2ESkipGuards();

test("dashboard sign-in completes without browser hydration errors", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (
      (message.type() === "error" || message.type() === "warning") &&
      /hydrat|did not match|cannot be a (?:child|descendant)/i.test(message.text())
    ) {
      browserErrors.push(message.text());
    }
  });

  await signInAsViaOtp(page, "alicia.moreno@spiralclass.test", "/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: /Hola/i })).toBeVisible();
  expect(browserErrors).toEqual([]);
});
