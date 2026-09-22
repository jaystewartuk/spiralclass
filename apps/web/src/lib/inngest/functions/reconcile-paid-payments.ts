import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { enqueueEvent } from "@/lib/jobs/enqueue";
import { reconcileStrandedPaidPayments } from "@/lib/payments/reconcile-paid";

// Hourly (was */15 until D-115): re-drive the `payment.paid` fan-out (teacher transfer,
// single-class auto-book, referral reward, magic link) for any Stripe payment
// that settled but whose teacher-payout transfer never ran — the signal that the
// webhook's best-effort post-commit emit was lost. Idempotent downstream; see
// lib/payments/reconcile-paid.ts for the failure mode this backstops.
export const reconcilePaidPaymentsCronFn = inngest.createFunction(
  {
    id: "reconcile-paid-payments-cron",
    retries: 3,
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step }) =>
    step.run("reconcile-stranded-paid", () =>
      reconcileStrandedPaidPayments({
        prisma,
        emit: (event) => enqueueEvent(event),
      }),
    ),
);
