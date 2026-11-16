import type { PrismaClient } from "@prisma/client";
import type { StripeClient } from "@/lib/stripe";
import { logger } from "@/lib/logger";
import {
  handleStripeWebhook,
  type WebhookDeps,
  type WebhookEventEmitter,
  type WebhookOutcome,
} from "./webhook-handler";

const log = logger({ surface: "settle-unconfirmed" });

// The backstop for a card payment whose webhook never arrived (#184).
//
// Until this existed, nothing outside the webhook handler ever asked Stripe
// what happened to a payment. If every delivery failed — a wrong secret, a
// misconfigured endpoint, a handler that throws on each retry until Stripe
// gives up after about three days — the package never activated, the student
// got no classes, and `cleanup-pending` hard-deleted the only record of the
// purchase a week later, leaving the teacher holding money nothing in
// SpiralClass could explain.
//
// So a Stripe payment still `pending` past the webhook's retry window is put to
// Stripe directly, on the teacher's own account (D-143 — the session is hers):
//
//   * paid      → settled by replaying `checkout.session.completed` through
//                 `handleStripeWebhook`. That re-fetches the session and the
//                 PaymentIntent from Stripe and applies the same guarded
//                 transition a real delivery would (D-79), so a webhook that
//                 lands at the same moment and the sweep cannot both activate
//                 the package: whichever commits second matches 0 rows.
//   * expired and unpaid → abandoned. The buyer never paid and the session can
//                 no longer take money, so `cleanup-pending` may delete it.
//   * anything else — still open, completed but awaiting an async transfer, or
//                 Stripe could not be asked → unresolved. Nothing is deleted on
//                 doubt; the next run asks again.
//
// The replay deliberately does not go through the webhook route's event-claim
// table: it is not a Stripe event, and the guarded transition is what makes a
// duplicate harmless.

export type StripeVerdict = "paid" | "abandoned" | "unresolved";

export type UnconfirmedStripePayment = {
  id: string;
  stripeCheckoutSessionId: string;
  /** The teacher's connected account; null only for pre-D-143 rows. */
  stripeAccountId: string | null;
};

export type SettleDeps = {
  prisma: WebhookDeps["prisma"];
  // Lazily resolved, as in supersede-pending: a deploy with no Stripe
  // credentials throws here, which must read as "could not ask", not crash.
  getStripe: () => StripeClient;
  emit?: WebhookEventEmitter;
  now?: () => Date;
};

export async function askStripeAboutPendingPayment(
  payment: UnconfirmedStripePayment,
  deps: SettleDeps,
): Promise<{ verdict: StripeVerdict; outcome?: WebhookOutcome }> {
  const account = payment.stripeAccountId ?? undefined;
  try {
    const stripe = deps.getStripe();
    const session = await stripe.getCheckoutSession(payment.stripeCheckoutSessionId, account);
    if (session.payment_status === "paid") {
      const outcome = await handleStripeWebhook(
        {
          id: `settle-unconfirmed:${session.id}`,
          type: "checkout.session.completed",
          data: { object: session },
          ...(account ? { account } : {}),
        },
        { prisma: deps.prisma, stripe, emit: deps.emit, now: deps.now },
      );
      // Whatever the replay concluded, Stripe holds this money: never let the
      // caller treat the row as abandoned.
      return { verdict: "paid", outcome };
    }
    if (session.status === "expired") return { verdict: "abandoned" };
    return { verdict: "unresolved" };
  } catch (err) {
    log.warn("could not ask Stripe about a pending payment", {
      paymentId: payment.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { verdict: "unresolved" };
  }
}

// Stripe retries a failed webhook delivery for up to three days. Before that a
// pending row may simply be waiting for a retry that will succeed.
const DEFAULT_MIN_AGE_DAYS = 3;
const DEFAULT_MAX_PER_RUN = 200;

export type SettleSweepDeps = SettleDeps & {
  prisma: SettleDeps["prisma"] & Pick<PrismaClient, "payment">;
  minAgeDays?: number;
  maxPerRun?: number;
};

export type SettleSweepOutcome = {
  scanned: number;
  /** Paid on Stripe and activated by this sweep: a webhook that never came. */
  settled: number;
  /** Paid on Stripe, but a delivery settled it first — the replay was a noop. */
  alreadySettled: number;
  abandoned: number;
  unresolved: number;
};

export async function settleUnconfirmedStripePayments(
  deps: SettleSweepDeps,
): Promise<SettleSweepOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - (deps.minAgeDays ?? DEFAULT_MIN_AGE_DAYS) * 86_400_000);

  // tenancy-exempt: a platform sweep over every teacher's unconfirmed payments; each one is then settled on its own teacher's Stripe account.
  const rows = await deps.prisma.payment.findMany({
    where: {
      provider: "stripe",
      status: "pending",
      stripeCheckoutSessionId: { not: null },
      createdAt: { lt: cutoff },
      package: { is: { status: "pending" } },
    },
    select: {
      id: true,
      stripeCheckoutSessionId: true,
      package: { select: { teacher: { select: { stripeAccountId: true } } } },
    },
    orderBy: { createdAt: "asc" },
    take: deps.maxPerRun ?? DEFAULT_MAX_PER_RUN,
  });

  const outcome: SettleSweepOutcome = {
    scanned: rows.length,
    settled: 0,
    alreadySettled: 0,
    abandoned: 0,
    unresolved: 0,
  };
  for (const row of rows) {
    if (!row.stripeCheckoutSessionId) continue;
    const { verdict, outcome: replay } = await askStripeAboutPendingPayment(
      {
        id: row.id,
        stripeCheckoutSessionId: row.stripeCheckoutSessionId,
        stripeAccountId: row.package.teacher.stripeAccountId,
      },
      deps,
    );
    if (verdict === "paid") {
      if (replay?.code === "applied") outcome.settled++;
      else outcome.alreadySettled++;
    } else if (verdict === "abandoned") outcome.abandoned++;
    else outcome.unresolved++;
  }

  if (outcome.settled > 0) {
    // Each of these is a payment whose webhook never landed. One is an
    // incident in the delivery path, not routine — say so loudly.
    log.error("settled paid Stripe payments the webhook never delivered", undefined, {
      ...outcome,
    });
  }
  return outcome;
}
