import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { getStripeClient } from "@/lib/stripe";
import { enqueueEvent } from "@/lib/jobs/enqueue";
import { cleanupAbandonedPendingPackages } from "@/lib/payments/cleanup-pending";
import {
  askStripeAboutPendingPayment,
  settleUnconfirmedStripePayments,
  type SettleDeps,
} from "@/lib/payments/settle-unconfirmed";

// Daily cron at 03:00 UTC, in two steps:
//   1. settle-unconfirmed — ask Stripe about every card payment still pending
//      past the webhook's three-day retry window, and settle the paid ones
//      through the webhook's own transition (#184).
//   2. cleanup-pending — drop Package + Payment rows still pending past 7 days
//      (14 for Wise), asking Stripe again before deleting a card checkout.
// Pure handlers in `src/lib/payments/`. The pg-boss twin in lib/jobs/crons.ts
// runs the same two calls through `runPendingCheckoutSweep`.

// The same seams the Stripe webhook route uses, so a settled payment fans out
// exactly as a delivered one would.
export function settleDeps(): SettleDeps {
  return { prisma, getStripe: () => getStripeClient(), emit: (event) => enqueueEvent(event) };
}

function cleanupAskingStripe(deps: SettleDeps) {
  return cleanupAbandonedPendingPackages({
    prisma,
    askStripe: async (payment) => (await askStripeAboutPendingPayment(payment, deps)).verdict,
  });
}

export async function runPendingCheckoutSweep() {
  const deps = settleDeps();
  const settle = await settleUnconfirmedStripePayments(deps);
  const cleanup = await cleanupAskingStripe(deps);
  return { settle, cleanup };
}

export const cleanupPendingPackagesCronFn = inngest.createFunction(
  {
    id: "cleanup-pending-packages-cron",
    retries: 1,
    triggers: [{ cron: "0 3 * * *" }],
  },
  async ({ step }) => {
    const deps = settleDeps();
    const settle = await step.run("settle-unconfirmed", () =>
      settleUnconfirmedStripePayments(deps),
    );
    const cleanup = await step.run("cleanup-pending", () => cleanupAskingStripe(deps));
    return { settle, cleanup };
  },
);
