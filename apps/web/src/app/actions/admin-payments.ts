"use server";

import { issueMessage } from "@spiralclass/shared";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { writeOverride } from "@/lib/audit";
import { getPreferredLocale } from "@/lib/i18n";
import { getStripeClient } from "@/lib/stripe";
import { applyRefund } from "@/lib/payments/refund";
import { logger } from "@/lib/logger";
import { revalidateAfterAction } from "@/lib/revalidate";
import { createT } from "@spiralclass/shared";

const log = logger({ surface: "admin-refund" });

export type AdminPaymentActionState =
  { error?: string; ok?: boolean; refundId?: string } | undefined;

const refundSchema = z.object({
  paymentId: z.string().uuid("web.action.invalidId"),
  reason: z.string().trim().min(1, "Motivo requerido").max(280),
});

// Admin-initiated full refund. Differs from the teacher-facing
// `refundPaymentAction` (src/app/actions/refund.ts) only in:
//   - gated by requireAdmin("finance") instead of requireOnboardedTeacher
//   - revalidates the admin surfaces
//   - records the actor admin id on the audit row
// Everything else — the guarded flip, the referral clawback, and telling the
// student and the teacher — is the shared `applyRefund`.
// MVP supports full refunds only.
export async function adminRefundPaymentAction(
  _prev: AdminPaymentActionState,
  formData: FormData,
): Promise<AdminPaymentActionState> {
  const actor = await requireAdmin("finance");
  const locale = await getPreferredLocale();
  const t = createT(locale);
  const parsed = refundSchema.safeParse({
    paymentId: formData.get("paymentId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      error: issueMessage(parsed.error, t, "web.action.invalidData"),
    };
  }

  const payment = await prisma.payment.findUnique({
    where: { id: parsed.data.paymentId },
    include: {
      package: {
        select: {
          id: true,
          teacherId: true,
          // applyRefund notifies the student, so it needs her row id.
          studentId: true,
          // Needed to refund AS the teacher — the charge is on her connected
          // account since D-143.
          teacher: { select: { stripeAccountId: true } },
        },
      },
    },
  });
  if (!payment) return { error: t("web.action.admin.paymentNotFound") };
  if (payment.status === "refunded") return { error: t("web.action.admin.alreadyRefunded") };
  if (payment.status !== "paid") {
    return {
      error: t("web.action.admin.onlyPaidRefundable"),
    };
  }
  // Wise transfers settle off-platform; Stripe can't refund them. Refund
  // them manually in Wise instead.
  if (payment.provider !== "stripe") {
    return {
      error: t("web.action.admin.wiseRefundManual"),
    };
  }
  if (!payment.providerPaymentId) {
    return {
      error: t("web.action.admin.missingPaymentIntent"),
    };
  }

  let refundProviderId: string;
  try {
    const stripe = getStripeClient();
    const refund = await stripe.createRefund({
      paymentIntentId: payment.providerPaymentId,
      reason: "requested_by_customer",
      connectedAccountId: payment.package.teacher.stripeAccountId ?? undefined,
    });
    refundProviderId = refund.id;
  } catch (err) {
    log.error("Stripe rejected", err, { paymentId: payment.id });
    return { error: t("web.action.admin.stripeRejectedRefund") };
  }

  // No clawback. Under direct charges (D-143) the charge lives on the teacher's
  // own connected account, so the refund debits HER balance directly and the
  // platform was never holding the money.

  // Shared with the teacher-facing action: the guarded flip, the referral
  // reward clawback, and the two notifications. This path had none of the
  // three — an admin refund voided nobody's reward and told nobody it had
  // happened, least of all the student whose money moved.
  await applyRefund({
    payment: { id: payment.id },
    package: payment.package,
    refundProviderId,
    audit: (tx) =>
      writeOverride({
        tx,
        teacherId: payment.package.teacherId,
        targetType: "payment",
        targetId: payment.id,
        action: "admin_refund",
        reason: parsed.data.reason,
        before: { status: "paid" },
        after: { status: "refunded", refundProviderId },
        actor,
      }),
  });

  revalidateAfterAction("/admin/payments");
  return { ok: true, refundId: refundProviderId };
}
