"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getStripeClient } from "@/lib/stripe";
import { applyRefund } from "@/lib/payments/refund";
import { logger } from "@/lib/logger";

const log = logger({ surface: "refund" });

const refundSchema = z.object({
  paymentId: z.string().uuid(),
  reason: z.string().min(1).max(200),
});

// Teacher-initiated full refund. Refunds: MVP supports full refunds only.
// Calls Stripe Refunds API server-side against the platform's secret
// key (Stripe pulls funds from the connected account's pending balance
// or future settlements), then in a transaction:
//   - flips Payment.status → refunded, sets refundedAt + refund_provider_id
//   - flips Package.status → refunded
//   - logs an Override row with the teacher's reason
//   - voids any unredeemed referral reward this payment had qualified
//   - notifies the student AND the teacher that the money went back
// The last three, and the race guard, are `applyRefund` — shared with the
// admin refund route so a refund means the same thing everywhere.
//
// Errors redirect back to /payments/[id]?error=<code> so the form
// surface shows readable copy.
export async function refundPaymentAction(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const parsed = refundSchema.safeParse({
    paymentId: formData.get("paymentId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    redirect("/payments?error=missing-reason");
  }
  const input = parsed.data;

  if (!teacher.stripeAccountId) {
    redirect(`/payments/${input.paymentId}?error=no-account`);
  }

  const payment = await prisma.payment.findFirst({
    where: { id: input.paymentId, package: { teacherId: teacher.id } },
    // teacherId + studentId are what applyRefund needs to tell both sides the
    // money went back — see lib/payments/refund.ts.
    include: { package: { select: { id: true, teacherId: true, studentId: true } } },
  });
  if (!payment) {
    redirect("/payments?error=missing-payment");
  }
  if (payment.status !== "paid") {
    redirect(`/payments/${input.paymentId}?error=not-paid`);
  }
  // Wise transfers settle off-platform; Stripe can't refund them.
  if (payment.provider !== "stripe") {
    redirect(`/payments/${input.paymentId}?error=not-stripe`);
  }
  if (!payment.providerPaymentId) {
    redirect(`/payments/${input.paymentId}?error=no-payment-intent`);
  }

  let refundProviderId: string;
  try {
    const stripe = getStripeClient();
    const refund = await stripe.createRefund({
      paymentIntentId: payment.providerPaymentId,
      reason: "requested_by_customer",
      // The charge is on HER account (D-143), so the refund must be created as
      // her. Guarded non-null by the stripeAccountId check above.
      connectedAccountId: teacher.stripeAccountId,
    });
    refundProviderId = refund.id;
  } catch (err) {
    log.error("Stripe rejected", err, { paymentId: payment.id });
    redirect(`/payments/${input.paymentId}?error=stripe-error`);
  }

  // No clawback step. Under direct charges (D-143) the charge lives on the
  // teacher's own connected account, so refunding it debits HER balance
  // directly — there is no platform-held transfer to reverse, and the platform
  // was never out of pocket to begin with.

  // The row flips, the reward clawback and BOTH notifications live in
  // applyRefund, shared with the admin refund path — including the
  // student's `refund_issued_student` notice, which this action used to
  // suppress by flipping the status before Stripe's webhook could enqueue it.
  await applyRefund({
    payment: { id: payment.id },
    package: payment.package,
    refundProviderId,
    audit: (tx) =>
      tx.override.create({
        data: {
          teacherId: teacher.id,
          targetType: "payment",
          targetId: payment.id,
          action: "refund",
          reason: input.reason,
          beforeJson: { status: "paid" },
          afterJson: { status: "refunded", refundProviderId },
        },
      }),
  });

  revalidatePath(`/payments/${input.paymentId}`);
  revalidatePath("/payments");
  redirect(`/payments/${input.paymentId}?refunded=1`);
}
