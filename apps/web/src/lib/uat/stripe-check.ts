// Automates /admin/uat's §B/§G "open the Stripe Dashboard and eyeball it"
// steps (runbook-steps.ts): confirms charge/transfer/refund state directly
// against Stripe's API — Stripe's own source of truth, independent of what
// our DB/webhook handling recorded (uat-verify.ts already proves the DB
// side). See D-55.
import { prisma } from "@/lib/prisma";
import { getStripeClient } from "@/lib/stripe";
import { isProductionDeployment } from "@/lib/env";
import type { UatTargetEnv } from "./env-targets";

type StripeCheckResult = { label: string; pass: boolean; detail: string };
export type StripeCheckReport = { env: UatTargetEnv; checks: StripeCheckResult[]; pass: boolean };

async function resolvePayment(input: { studentEmail?: string; paymentId?: string }) {
  // `package.teacher.stripeAccountId` comes along because since D-143 the
  // charge lives on HER connected account — every Stripe read below is scoped
  // to it, and a platform-scoped one would report "not settled" for a payment
  // that settled perfectly well.
  const withTeacher = {
    package: { select: { teacher: { select: { stripeAccountId: true } } } },
  } as const;
  if (input.paymentId) {
    return prisma.payment.findUnique({
      where: { id: input.paymentId },
      include: withTeacher,
    });
  }
  if (input.studentEmail) {
    const student = await prisma.student.findFirst({
      where: { email: input.studentEmail },
      select: { id: true },
    });
    if (!student) return null;
    return prisma.payment.findFirst({
      where: { package: { studentId: student.id } },
      orderBy: { createdAt: "desc" },
      include: withTeacher,
    });
  }
  return null;
}

export async function runStripeCheck(
  env: UatTargetEnv,
  input: { studentEmail?: string; paymentId?: string },
): Promise<StripeCheckReport> {
  const actuallyProd = isProductionDeployment();
  if ((env === "production") !== actuallyProd) {
    return {
      env,
      pass: false,
      checks: [
        {
          label: "environment-match",
          pass: false,
          detail: `Can't check "${env}" data from here — this deployment is actually running on ${
            actuallyProd ? "production" : "preview"
          }. The Prisma/Stripe clients this check uses always point at whatever's actually running.`,
        },
      ],
    };
  }

  const checks: StripeCheckResult[] = [];
  const payment = await resolvePayment(input);
  if (!payment) {
    return {
      env,
      pass: false,
      checks: [{ label: "payment-exists", pass: false, detail: "no matching payment found" }],
    };
  }

  const stripe = getStripeClient();

  if (!payment.providerPaymentId) {
    checks.push({
      label: "charge-settled",
      pass: false,
      detail: "payment has no Stripe PaymentIntent id",
    });
  } else {
    const teacherAccount = payment.package.teacher.stripeAccountId ?? undefined;
    const settled = await stripe.getSettledCharge(payment.providerPaymentId, teacherAccount);
    checks.push({
      label: "charge-settled",
      pass: settled != null,
      detail: settled
        ? `settled, net ${settled.netMinorUnits} minor units`
        : "not settled at Stripe",
    });

    if (settled) {
      const charge = await stripe.getCharge(settled.chargeId, teacherAccount);
      const expectRefunded = payment.refundedAt != null;
      const refundedOk = Boolean(charge.refunded) === expectRefunded;
      checks.push({
        label: "charge-refund-status",
        pass: refundedOk,
        detail: `Stripe charge.refunded=${charge.refunded ?? false} (our DB expects ${expectRefunded})`,
      });
    }
  }

  // No transfer checks. Under direct charges (D-143) the card rail creates the
  // charge ON the teacher's connected account, so there is no platform-side
  // Transfer object to confirm and no reversal to assert on a refund — the
  // refund debits her balance directly. What replaced them as the meaningful
  // assertion is `charge-refund-status` above, which already reads the real
  // charge state back from Stripe.

  return { env, checks, pass: checks.every((c) => c.pass) };
}
