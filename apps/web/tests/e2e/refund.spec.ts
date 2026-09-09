import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

import {
  applyE2ESkipGuards,
  deleteStudentsByEmail,
  getPrisma,
  missingEnv,
  purchaseAndActivatePackage,
  signInAsViaOtp,
  TEACHER_EMAIL,
} from "./_helpers";

// UAT §G — teacher-initiated full refund (the "real reversal" section of the
// manual runbook, src/lib/uat/runbook-steps.ts). This was the largest
// zero-coverage hole in the suite: a Tier 2 money path with no automated test
// on either platform, verified only by hand against a live Stripe account
// before each promote.
//
// SCOPE — what this adds over tests/admin/refund-action.test.ts, which already
// covers refundPaymentAction thoroughly at the unit level (including that the
// refund is issued AS the connected account, since the charge is hers). None
// of that is re-proved here.
//
// This spec covers the layer those unit tests mock away: that the real UI
// reaches the action at all. The refund is only offered when the page's
// `refundable` predicate holds, the reason travels from a dialog-scoped form
// through a two-step ConfirmDialog, and success is a redirect the teacher can
// actually see. A broken `refundable` condition, a renamed form field, or a
// dialog that never opens would leave every unit test green and no teacher
// able to refund anyone.
//
// NO LONGER ASSERTED, and not because it got hard: there is no transfer
// reversal any more (D-143). The charge is created on the teacher's own
// connected account, so a refund debits HER balance directly and the platform
// has nothing to claw back. This spec used to plant a `stripeTransferId` on
// the payment purely so the reversal branch would fire; that column is gone.
//
// Runs hermetically against the in-memory Stripe stub (lib/stripe/stub.ts) —
// no Stripe credentials, no network, same as the rest of the gate.
//
// Gated on E2E_EXTENDED=1 (the e2e.yml promote gate sets it), like every
// journey beyond the happy path.

applyE2ESkipGuards({ extended: true });

const created: string[] = [];

test.describe.serial("teacher refund (§G)", () => {
  test("teacher refunds a paid card payment → Stripe refund, package refunded", async ({
    page,
    context,
  }) => {
    test.setTimeout(240_000);
    const prisma = getPrisma();

    // The Checkout stub is aborted rather than followed, so Stripe never writes
    // back the ids a real charge would leave behind. Plant the PaymentIntent id:
    // the refund is gated on `providerPaymentId`, and with no PaymentIntent
    // there is no refund button to click. A transfer id used to be planted
    // beside it to make the clawback branch fire; there is no clawback now.
    const runId = randomUUID().slice(0, 8);
    const paymentIntentId = `pi_e2e_${runId}`;

    const { studentEmail, paymentId, packageId } = await purchaseAndActivatePackage(page, context, {
      paymentOverrides: { providerPaymentId: paymentIntentId },
    });
    created.push(studentEmail);

    // Teacher opens the payment detail. The refund form only renders when the
    // payment is stripe + paid + has a PaymentIntent (page.tsx `refundable`),
    // so its presence is itself the assertion that those preconditions hold.
    await context.clearCookies();
    await signInAsViaOtp(page, TEACHER_EMAIL, `/payments/${paymentId}`);
    await expect(page).toHaveURL(new RegExp(`/payments/${paymentId}`), { timeout: 30_000 });

    // Two-step, same shape as the student cancel: a destructive trigger opens a
    // ConfirmDialog (role="alertdialog") holding the reason field + submit.
    // Teacher-facing copy is Spanish (playwright.config pins locale es-MX).
    const dialog = page.getByRole("alertdialog");
    const confirmBtn = dialog.getByRole("button", { name: /Confirmar reembolso/i });
    // Retry trigger-until-dialog: a click landing before hydration is swallowed
    // and the dialog never opens (same guard the booking specs use for slots).
    await expect(async () => {
      await page.getByRole("button", { name: /^Reembolsar$/i }).click();
      await expect(confirmBtn).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });

    const reason = `E2E refund ${runId}`;
    await dialog.getByLabel(/Motivo/i).fill(reason);
    await confirmBtn.click();

    // The action redirects back with ?refunded=1 and the page shows the banner.
    await expect(page).toHaveURL(new RegExp(`/payments/${paymentId}\\?refunded=1`), {
      timeout: 30_000,
    });

    // ---- Money state ----
    await expect
      .poll(
        async () => {
          const p = await prisma.payment.findUnique({
            where: { id: paymentId },
            select: { status: true },
          });
          return p?.status ?? "missing";
        },
        { timeout: 15_000 },
      )
      .toBe("refunded");

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { refundedAt: true, refundProviderId: true },
    });
    expect(payment?.refundedAt).not.toBeNull();
    // Written from the Stripe response, not hardcoded — asserts the refund call
    // actually reached the Stripe layer rather than the row being flipped
    // locally.
    expect(payment?.refundProviderId).toBeTruthy();

    const pkg = await prisma.package.findUnique({
      where: { id: packageId },
      select: { status: true },
    });
    expect(pkg?.status).toBe("refunded");

    // ---- Audit trail ----
    // The Override row is how a teacher's refund is explained after the fact
    // (/admin surfaces read it); a refund that moves money without leaving one
    // is a compliance gap, not just a missing log line.
    const override = await prisma.override.findFirst({
      where: { targetType: "payment", targetId: paymentId, action: "refund" },
      select: { reason: true, beforeJson: true, afterJson: true },
    });
    expect(override?.reason).toBe(reason);
    expect(override?.beforeJson).toMatchObject({ status: "paid" });
    expect(override?.afterJson).toMatchObject({ status: "refunded" });
  });

  test("a refunded payment is no longer refundable (no double refund)", async ({ page }) => {
    test.setTimeout(120_000);
    const prisma = getPrisma();

    // Reuse the payment the previous test refunded (describe.serial) rather
    // than driving the funnel again — this asserts the UI reflects the new
    // state, which is the cheap half of double-refund safety. The expensive
    // half (two concurrent submits racing) is the action's own
    // `where: { status: "paid" }` guard, covered by unit tests.
    const refunded = await prisma.payment.findFirst({
      where: { status: "refunded", package: { student: { email: { in: created } } } },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    expect(refunded, "previous test should have left a refunded payment").toBeTruthy();

    await signInAsViaOtp(page, TEACHER_EMAIL, `/payments/${refunded!.id}`);
    await expect(page).toHaveURL(new RegExp(`/payments/${refunded!.id}`), { timeout: 30_000 });
    await expect(page.getByRole("button", { name: /^Reembolsar$/i })).toHaveCount(0);
  });

  test.afterAll(async () => {
    if (missingEnv.length > 0 || process.env.E2E_EXTENDED !== "1") return;
    await deleteStudentsByEmail(created).catch(() => undefined);
    await getPrisma().$disconnect();
  });
});
