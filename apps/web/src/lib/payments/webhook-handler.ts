import type { PrismaClient } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import type { StripeClient } from "@/lib/stripe";
import {
  stripeAccountSchema,
  stripeChargeSchema,
  stripeCheckoutSessionSchema,
  stripeDisputeSchema,
  stripePaymentIntentSchema,
  stripeWebhookEnvelopeSchema,
  normalizeRail,
  type StripeDispute,
  type StripeWebhookEnvelope,
} from "@/lib/stripe/types";
import { capturedBillingFromAddress } from "@/lib/stripe/billing-address";
import { advancePayment, type PaymentSnapshot, type StripeOutcomeInput } from "./state";
import {
  enqueuePaymentFailedStudent,
  enqueuePaymentReceived,
  enqueuePaymentReceivedTeacher,
  enqueueDisputeLostStudent,
  enqueueDisputeLostTeacher,
  enqueueRefundIssuedStudent,
  enqueueRefundIssuedTeacher,
  enqueueStripeReadyTeacher,
  enqueueStripeRequirementsTeacher,
} from "@/lib/notifications/enqueue";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { maybeEmitFirstPayment } from "@/lib/analytics/first-events";
import { maybeEmitMarketplaceReady } from "@/lib/marketplace-ready";
import { voidReferralRewardForPayment } from "@/lib/referrals";
import { activatePackage } from "./activate-package";
import { recordPurchaseForActivation } from "@/lib/marketing/events";
import { logger } from "@/lib/logger";

const log = logger({ surface: "stripe-webhook" });

// Outcome codes — used by the route to log + by tests to assert.
export type WebhookOutcome =
  | { code: "ignored-unhandled-type"; type: string }
  | { code: "ignored-malformed-envelope"; reason: string }
  | { code: "applied-account-updated"; accountId: string; teacherId: string | null }
  | { code: "no-payment-row"; clientReferenceId: string | null }
  | { code: "noop"; reason: string }
  | {
      code: "applied";
      action: "flip-paid" | "flip-failed" | "flip-refunded";
      paymentId: string;
      packageId: string;
    }
  | {
      code: "applied-dispute";
      action: "upsert" | "skip-unmatched";
      stripeDisputeId: string;
      paymentId: string | null;
      status: StripeDispute["status"];
    };

// Callback used to emit Inngest events for downstream handlers:
//   * `notification.queued` — picked up by dispatchNotification
//   * `payment.paid` — picked up by magicLinkOnFirstPayment
// Injecting the emitter (rather than importing the Inngest client here)
// keeps this module test-friendly: tests pass a recorder; production
// passes the real Inngest `send`. See src/app/api/stripe/webhook/route.ts.
export type WebhookEventEmitter = (
  event:
    | { name: "notification.queued"; data: { notificationId: string; teacherId: string } }
    | {
        name: "payment.paid";
        data: { paymentId: string; packageId: string; teacherId: string; studentId: string };
      },
) => Promise<void>;

export type WebhookDeps = {
  prisma: Pick<
    PrismaClient,
    "teacher" | "payment" | "package" | "$transaction" | "notification" | "dispute"
  >;
  stripe: StripeClient;
  now?: () => Date;
  emit?: WebhookEventEmitter;
};

// Pure-ish handler invoked by the route after signature verification.
// Receives a *parsed* webhook envelope; dispatches by `event.type`. All
// state mutations go through a single transaction per branch so a crash
// mid-handler doesn't leave the system half-applied. Notifications are
// enqueued only — actual delivery is Slice 4 (Inngest dispatcher reads
// `notifications` rows in status='queued').
//
// refunds: never trust the webhook payload — re-fetch from Stripe via the
// platform key and use that as the source of truth.
export async function handleStripeWebhook(
  raw: unknown,
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  const parsed = stripeWebhookEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      code: "ignored-malformed-envelope",
      reason: parsed.error.issues[0]?.message ?? "unparseable",
    };
  }
  const envelope = parsed.data;

  switch (envelope.type) {
    case "account.updated":
      return handleAccountUpdated(envelope, deps);
    case "checkout.session.completed":
      return handleCheckoutSessionCompleted(envelope, deps);
    // An ASYNC method (Stripe bank transfer, OXXO — both live for a Mexican
    // teacher) leaves `checkout.session.completed` with payment_status
    // 'unpaid'. These two are how that session ends, hours or days later.
    // Stripe has been sending both on the Connect destination since D-143;
    // nothing handled them, so they fell through to ignored-unhandled-type.
    //
    // Success re-enters the completed handler, which re-fetches the session —
    // now payment_status 'paid' — and takes the ordinary path.
    // `payment_intent.succeeded` usually lands too; the guarded update makes
    // whichever arrives second a `already-transitioned` noop.
    case "checkout.session.async_payment_succeeded":
      return handleCheckoutSessionCompleted(envelope, deps);
    // Failure is the one with no other event behind it. A bank transfer that
    // is never funded fires this and NOT payment_intent.payment_failed, so
    // without this case the Payment row sits `pending` for ever and the
    // Package quietly expires unpaid — four rows in production look exactly
    // like that.
    case "checkout.session.async_payment_failed":
      return handleAsyncCheckoutFailed(envelope, deps);
    // The buyer opened checkout and never paid. Stripe expires the session
    // (24h for a card session) and this is the ONLY event that reports it —
    // there is no PaymentIntent, so no payment_intent.* ever fires.
    //
    // Without it the Payment row sits `pending` for ever and the Package
    // silently expires unpaid, which is the state four production rows were
    // found in. The async_payment_failed case covers a funded-transfer window
    // closing; this covers the plainer "never started paying" case.
    case "checkout.session.expired":
      return handleCheckoutSessionExpired(envelope, deps);
    case "payment_intent.succeeded":
      return handlePaymentIntentTransition(envelope, deps, "succeeded");
    case "payment_intent.payment_failed":
      return handlePaymentIntentTransition(envelope, deps, "failed");
    case "charge.refunded":
      return handleChargeRefunded(envelope, deps);
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated":
    case "issuing_dispute.created":
    case "issuing_dispute.updated":
      return handleDispute(envelope, deps);
    default:
      return { code: "ignored-unhandled-type", type: envelope.type };
  }
}

// ---------- charge.dispute.* ----------
//
// docs/security.md. We upsert by `stripe_dispute_id` so any
// of the five subevents (created, updated, closed, funds_withdrawn,
// funds_reinstated) collapse to the latest state. The teacher row is
// resolved through the Payment → Package → teacher chain when the
// charge ties back to one of our PaymentIntents; otherwise the dispute
// row is recorded without a teacher and flagged for ops attention.

async function handleDispute(
  envelope: StripeWebhookEnvelope,
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  const parsed = stripeDisputeSchema.safeParse(envelope.data.object);
  if (!parsed.success) {
    return {
      code: "ignored-malformed-envelope",
      reason: "dispute payload invalid",
    };
  }
  const dispute = parsed.data;
  const now = (deps.now ?? (() => new Date()))();

  // Resolve the Payment row via PaymentIntent when Stripe surfaces it.
  // Issuer warnings can arrive without a PI link; we keep the row anyway.
  let paymentId: string | null = null;
  let teacherId: string | null = null;
  let packageId: string | null = null;
  let studentId: string | null = null;
  if (dispute.payment_intent) {
    const payment = await deps.prisma.payment.findFirst({
      where: { providerPaymentId: dispute.payment_intent },
      select: {
        id: true,
        // studentId so a lost dispute can tell her that her classes are gone.
        package: { select: { id: true, teacherId: true, studentId: true } },
      },
    });
    if (payment) {
      paymentId = payment.id;
      teacherId = payment.package.teacherId;
      packageId = payment.package.id;
      studentId = payment.package.studentId;
    }
  }

  const evidenceDueBy = dispute.evidence_details?.due_by
    ? new Date(dispute.evidence_details.due_by * 1000)
    : null;
  const isFinal =
    dispute.status === "won" ||
    dispute.status === "lost" ||
    dispute.status === "warning_closed" ||
    dispute.is_charge_refundable === false;

  await deps.prisma.dispute.upsert({
    where: { stripeDisputeId: dispute.id },
    create: {
      stripeDisputeId: dispute.id,
      stripeChargeId: dispute.charge,
      stripePaymentIntentId: dispute.payment_intent ?? null,
      paymentId,
      teacherId,
      amountMinorUnits: dispute.amount,
      currency: dispute.currency,
      reason: dispute.reason,
      status: dispute.status,
      evidenceDueBy,
      isFinal,
    },
    update: {
      paymentId: paymentId ?? undefined,
      teacherId: teacherId ?? undefined,
      status: dispute.status,
      evidenceDueBy,
      isFinal,
    },
  });

  // A lost dispute debits the disputed amount + the dispute fee from the
  // TEACHER's balance — under direct charges she is the merchant of record and
  // `losses_collector` is Stripe, so the platform is never out of pocket and
  // has nothing to claw back (D-143). What still has to happen here is revoking
  // the credits: the student holds active class credits paid for by a
  // charged-back card. Guarded updateMany so a redelivered/duplicate
  // `lost`/`funds_withdrawn` event is a no-op on the second pass.
  //
  // BOTH SIDES ARE TOLD. This branch used to revoke the credits in silence:
  // the student's package simply became "Reembolsado" with no notice at all,
  // and the teacher — whose balance the money came out of — had only the
  // Sentry alert below, which is routed to ops rather than to her. The copy is
  // deliberately its own rather than reusing `refund_issued_*`, because
  // nothing was refunded here and saying so would be wrong about what happened
  // to both of them.
  const disputeNotificationIds: string[] = [];
  if (dispute.status === "lost" && paymentId) {
    const lostPaymentId = paymentId;
    const lostTeacherId = teacherId;
    const lostStudentId = studentId;
    await deps.prisma.$transaction(async (tx) => {
      const flipped = await tx.payment.updateMany({
        where: { id: lostPaymentId, status: "paid" },
        data: { status: "refunded", refundedAt: now },
      });
      if (flipped.count === 0) return;
      if (packageId) {
        await tx.package.update({ where: { id: packageId }, data: { status: "refunded" } });
      }
      // A lost dispute is money out the door like a refund — void any unredeemed
      // referral reward this payment earned (slice 2b).
      await voidReferralRewardForPayment(tx, lostPaymentId);

      // Guarded on the same lookup that produced paymentId, so an unmatched
      // raw charge (which has nobody to address) cannot reach this.
      if (lostTeacherId && lostStudentId) {
        disputeNotificationIds.push(
          await enqueueDisputeLostStudent(tx, {
            teacherId: lostTeacherId,
            studentId: lostStudentId,
            paymentId: lostPaymentId,
          }),
        );
        disputeNotificationIds.push(
          await enqueueDisputeLostTeacher(tx, {
            teacherId: lostTeacherId,
            paymentId: lostPaymentId,
          }),
        );
      }
    });
  }

  // After the commit, so nothing dispatches for a rolled-back insert.
  // Best-effort, exactly as on the paid/refunded transitions below: the rows
  // are queued either way and a failed emit must not fail the webhook.
  if (deps.emit && teacherId) {
    for (const notificationId of disputeNotificationIds) {
      try {
        await deps.emit({
          name: "notification.queued",
          data: { notificationId, teacherId },
        });
      } catch (err) {
        log.error("emit notification.queued failed", err);
      }
    }
  }

  // Surface to Sentry so the ops alert routing (Sentry → Resend list)
  // picks it up. A lost dispute is money out the door and needs ops attention,
  // so it escalates to `error`; `needs_response` is a `warning` because every
  // minute we delay reduces our chance of winning. Other states are `info`.
  Sentry.captureMessage("[stripe-webhook] dispute event", {
    level:
      dispute.status === "lost"
        ? "error"
        : dispute.status === "needs_response"
          ? "warning"
          : "info",
    tags: {
      surface: "stripe-dispute",
      status: dispute.status,
      reason: dispute.reason,
    },
    extra: {
      stripeDisputeId: dispute.id,
      amountMinorUnits: dispute.amount,
      currency: dispute.currency,
      teacherId: teacherId ?? "unmatched",
      evidenceDueBy: evidenceDueBy?.toISOString() ?? null,
    },
  });

  return {
    code: "applied-dispute",
    action: paymentId ? "upsert" : "skip-unmatched",
    stripeDisputeId: dispute.id,
    paymentId,
    status: dispute.status,
  };
}

// ---------- account.updated ----------

async function handleAccountUpdated(
  envelope: StripeWebhookEnvelope,
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  const account = stripeAccountSchema.safeParse(envelope.data.object);
  if (!account.success) {
    return { code: "ignored-malformed-envelope", reason: "account.updated payload invalid" };
  }
  // Re-fetch to be sure we have current state.
  const fresh = await deps.stripe.getConnectedAccount(account.data.id);
  const teacher = await deps.prisma.teacher.findFirst({
    where: { stripeAccountId: fresh.id },
    select: { id: true, stripeChargesEnabled: true },
  });
  if (!teacher) {
    return {
      code: "applied-account-updated",
      accountId: fresh.id,
      teacherId: null,
    };
  }

  // charges_enabled transition gates the welcome / action-needed notification:
  //   false → true  → "stripe_ready_teacher" (one-time welcome / unblock)
  //   true  → false → "stripe_requirements_teacher" (action-needed alert)
  // Stripe sends account.updated frequently, and two deliveries (or a
  // concurrent connect/return write) can race: `previousChargesEnabled` is read
  // OUTSIDE the transaction, so a plain update would let both observe the same
  // prior value and both enqueue. Use an atomic CONDITIONAL flip keyed on the
  // prior value — only the worker whose update actually matched performs the
  // transition (and enqueues); the loser's updateMany affects 0 rows.
  const previousChargesEnabled = teacher.stripeChargesEnabled;
  const nextChargesEnabled = fresh.charges_enabled;

  let notificationId: string | null = null;
  // Only the delivery that actually wins the atomic false→true flip below marks
  // the teacher as newly payout-ready, so `payout_rail_connected` fires exactly
  // once (analytics is emitted AFTER the transaction commits, never inside it).
  let becamePayoutReady = false;
  // A restricted/rejected account
  // previously looked identical to "not yet verified" — the richer
  // requirements fields were parsed but never surfaced. Synced on every
  // delivery (not just charges_enabled transitions) so it reflects the
  // latest reason even when Stripe adds/clears requirements without flipping
  // charges_enabled.
  const requirementsDisabledReason = fresh.requirements?.disabled_reason ?? null;

  await deps.prisma.$transaction(async (tx) => {
    if (nextChargesEnabled === previousChargesEnabled) {
      // No charges transition this delivery — just sync the payouts mirror.
      await tx.teacher.update({
        where: { id: teacher.id },
        data: {
          stripePayoutsEnabled: fresh.payouts_enabled,
          stripeRequirementsDisabledReason: requirementsDisabledReason,
        },
      });
      return;
    }
    const flip = await tx.teacher.updateMany({
      where: { id: teacher.id, stripeChargesEnabled: previousChargesEnabled },
      data: {
        stripeChargesEnabled: nextChargesEnabled,
        stripePayoutsEnabled: fresh.payouts_enabled,
        stripeRequirementsDisabledReason: requirementsDisabledReason,
      },
    });
    // Lost the race — another delivery already performed this transition.
    if (flip.count === 0) return;
    becamePayoutReady = nextChargesEnabled;
    notificationId = nextChargesEnabled
      ? await enqueueStripeReadyTeacher(tx, { teacherId: teacher.id })
      : await enqueueStripeRequirementsTeacher(tx, { teacherId: teacher.id });
  });

  // Teacher just crossed into "can receive payouts" on the Stripe rail.
  if (becamePayoutReady) {
    trackServerEvent({
      name: "payout_rail_connected",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id, rail: "stripe" },
    });
    // Uses deps.prisma (not the global singleton) — see the comment on
    // maybeEmitMarketplaceReady in lib/marketplace-ready.ts: this handler's
    // Prisma client is injected for testability, exactly like
    // maybeEmitFirstPayment below.
    await maybeEmitMarketplaceReady(deps.prisma, teacher.id);
  }

  if (notificationId && deps.emit) {
    try {
      await deps.emit({
        name: "notification.queued",
        data: { notificationId, teacherId: teacher.id },
      });
    } catch (err) {
      log.error("emit notification.queued failed (account.updated)", err);
    }
  }

  return {
    code: "applied-account-updated",
    accountId: fresh.id,
    teacherId: teacher.id,
  };
}

// ---------- checkout.session.completed ----------

async function handleCheckoutSessionCompleted(
  envelope: StripeWebhookEnvelope,
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  const session = stripeCheckoutSessionSchema.safeParse(envelope.data.object);
  if (!session.success) {
    return {
      code: "ignored-malformed-envelope",
      reason: "checkout.session payload invalid",
    };
  }
  // Re-fetch — payload may be stale. Scoped to the connected account the event
  // came from: since D-143 the session lives on the TEACHER's account, so a
  // platform-scoped retrieve would 404. Connect events carry `account`.
  const fresh = await deps.stripe.getCheckoutSession(session.data.id, envelope.account);

  // Package templates (post-cleanup): only mode='payment' is supported. Subscriptions
  // were removed entirely. Anything else is an unhandled type.
  if (fresh.mode !== "payment") {
    return { code: "ignored-unhandled-type", type: `checkout.session.completed:${fresh.mode}` };
  }

  // resolve the Payment row by client_reference_id (UUID).
  const clientRef = fresh.client_reference_id ?? null;
  if (!clientRef) {
    return { code: "no-payment-row", clientReferenceId: null };
  }

  const payment = await deps.prisma.payment.findFirst({
    where: { externalReference: clientRef },
    include: {
      package: {
        select: { id: true, teacherId: true, studentId: true, templateId: true },
      },
    },
  });
  if (!payment) {
    return { code: "no-payment-row", clientReferenceId: clientRef };
  }

  // VAT/GST readiness (global-launch item 7): persist the billing country +
  // address Stripe collected on the hosted page, independent of the paid/unpaid
  // transition below so it's captured even before the PI settles. Idempotent —
  // a redelivery re-writes the same values; skipped when nothing was collected
  // so we never null out a value from an earlier delivery.
  const captured = capturedBillingFromAddress(fresh.customer_details?.address);
  if (captured) {
    await deps.prisma.payment.update({
      where: { id: payment.id },
      data: {
        billingCountry: captured.billingCountry,
        billingAddressJson: captured.billingAddressJson,
      },
    });
  }

  // Stripe Checkout sets payment_status='paid' on success. Failed
  // payments leave the session in `expired`/`unpaid` and we wait for
  // payment_intent.payment_failed to fire (handled separately).
  if (fresh.payment_status !== "paid") {
    // Record the session id so the success page has something to look
    // up if the user lands there before the PI lands; status stays
    // `pending` until success.
    await deps.prisma.payment.update({
      where: { id: payment.id },
      data: { stripeCheckoutSessionId: fresh.id },
    });
    return { code: "noop", reason: `session-payment-status-${fresh.payment_status ?? "null"}` };
  }

  // Re-fetch the PaymentIntent to confirm `succeeded` + read amount + rail.
  if (!fresh.payment_intent) {
    return { code: "noop", reason: "session-paid-without-payment-intent" };
  }
  const pi = await deps.stripe.getPaymentIntent(fresh.payment_intent, envelope.account);
  const rail = normalizeRail(railFromPaymentIntent(pi));

  const now = (deps.now ?? (() => new Date()))();
  const stripeOutcome: StripeOutcomeInput = {
    kind: "succeeded",
    paymentIntentId: pi.id,
    amountReceivedMinorUnits: pi.amount_received ?? pi.amount,
    currency: pi.currency,
    rail,
  };
  return await applyTransition(payment, stripeOutcome, fresh.id, deps, now);
}

// ---------- payment_intent.{succeeded, payment_failed} ----------

// `checkout.session.expired` — the buyer never paid at all.
//
// Unlike every other failure path there is usually no PaymentIntent to work
// from, so this cannot delegate to the payment_intent transition: it resolves
// the row by `client_reference_id` (always set at creation) and applies a
// `failed` outcome with a null intent, which the state machine accepts.
//
// A session that expired AFTER being paid is not a failure — Stripe can expire
// a completed session — so payment_status is checked before touching anything.
async function handleCheckoutSessionExpired(
  envelope: StripeWebhookEnvelope,
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  const session = stripeCheckoutSessionSchema.safeParse(envelope.data.object);
  if (!session.success) {
    return { code: "ignored-malformed-envelope", reason: "checkout.session payload invalid" };
  }
  const fresh = await deps.stripe.getCheckoutSession(session.data.id, envelope.account);
  if (fresh.mode !== "payment") {
    return { code: "ignored-unhandled-type", type: `checkout.session.expired:${fresh.mode}` };
  }
  // Paid-then-expired: the money arrived, so this event says nothing about it.
  if (fresh.payment_status === "paid") {
    return { code: "noop", reason: "expired-after-paid" };
  }

  const clientRef = fresh.client_reference_id ?? null;
  if (!clientRef) {
    return { code: "no-payment-row", clientReferenceId: null };
  }
  const payment = await deps.prisma.payment.findFirst({
    where: { externalReference: clientRef },
    include: {
      package: {
        select: { id: true, teacherId: true, studentId: true, templateId: true },
      },
    },
  });
  if (!payment) {
    return { code: "no-payment-row", clientReferenceId: clientRef };
  }

  const now = (deps.now ?? (() => new Date()))();
  return await applyTransition(
    payment,
    { kind: "failed", paymentIntentId: fresh.payment_intent ?? null, rail: "unknown" },
    fresh.id,
    deps,
    now,
  );
}

// `checkout.session.async_payment_failed` — the unfunded bank transfer.
//
// The session carries the PaymentIntent, so this resolves it and reuses the
// same transition the payment_intent.* events take: one place decides what
// "failed" does to a Payment row, whichever event reports it.
async function handleAsyncCheckoutFailed(
  envelope: StripeWebhookEnvelope,
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  const session = stripeCheckoutSessionSchema.safeParse(envelope.data.object);
  if (!session.success) {
    return { code: "ignored-malformed-envelope", reason: "checkout.session payload invalid" };
  }
  // Re-fetch on the account the event came from — same reasoning as the
  // completed handler: since D-143 the session is the teacher's.
  const fresh = await deps.stripe.getCheckoutSession(session.data.id, envelope.account);
  if (!fresh.payment_intent) {
    // A session can fail before Stripe ever attaches a PaymentIntent. There is
    // no charge to reconcile, so there is nothing to transition.
    return { code: "noop", reason: "async-failed-without-payment-intent" };
  }
  // `client_reference_id` is our own UUID and is always set at session
  // creation, whereas the PaymentIntent only carries `external_reference` when
  // `payment_intent_data.metadata` propagated. Pass it so the row is found
  // either way — a failed payment that cannot be matched is the case that
  // leaves a buyer stuck.
  return handlePaymentIntentTransition(
    envelope,
    deps,
    "failed",
    fresh.payment_intent,
    fresh.client_reference_id ?? null,
  );
}

async function handlePaymentIntentTransition(
  envelope: StripeWebhookEnvelope,
  deps: WebhookDeps,
  kind: "succeeded" | "failed",
  // Supplied when the event was a `checkout.session.*` rather than a
  // `payment_intent.*` — the id then comes from the session, not the body.
  paymentIntentId?: string,
  // The session's `client_reference_id`, when this came in via a session
  // event. Used only if the PaymentIntent itself carries no
  // `external_reference` metadata.
  externalReferenceHint?: string | null,
): Promise<WebhookOutcome> {
  let resolvedPaymentIntentId = paymentIntentId;
  if (!resolvedPaymentIntentId) {
    const pi = stripePaymentIntentSchema.safeParse(envelope.data.object);
    if (!pi.success) {
      return { code: "ignored-malformed-envelope", reason: "payment_intent payload invalid" };
    }
    resolvedPaymentIntentId = pi.data.id;
  }
  // Re-fetch, on the account the event came from (D-143 — the PaymentIntent is
  // the teacher's). This is also the path an ASYNC payment method takes: OXXO or
  // SPEI leaves checkout.session.completed unpaid, and this event, hours later,
  // is what actually flips the row.
  const fresh = await deps.stripe.getPaymentIntent(resolvedPaymentIntentId, envelope.account);
  const rail = normalizeRail(railFromPaymentIntent(fresh));

  // Resolve Payment row. Two paths: provider_payment_id matches (set
  // when the session.completed event already landed) OR metadata
  // carries our external_reference UUID (always set on creation).
  const externalRef = (fresh.metadata ?? {})["external_reference"] ?? externalReferenceHint ?? null;
  const payment = await deps.prisma.payment.findFirst({
    where: {
      OR: [
        { providerPaymentId: fresh.id },
        externalRef ? { externalReference: externalRef } : { id: "__never__" },
      ],
    },
    include: {
      package: {
        select: { id: true, teacherId: true, studentId: true, templateId: true },
      },
    },
  });
  if (!payment) {
    return { code: "no-payment-row", clientReferenceId: externalRef };
  }

  const now = (deps.now ?? (() => new Date()))();
  const stripeOutcome: StripeOutcomeInput =
    kind === "succeeded"
      ? {
          kind: "succeeded",
          paymentIntentId: fresh.id,
          amountReceivedMinorUnits: fresh.amount_received ?? fresh.amount,
          currency: fresh.currency,
          rail,
        }
      : { kind: "failed", paymentIntentId: fresh.id, rail };
  return await applyTransition(payment, stripeOutcome, null, deps, now);
}

// ---------- charge.refunded ----------

async function handleChargeRefunded(
  envelope: StripeWebhookEnvelope,
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  // Validate the payload shape rather than trusting an unchecked cast —
  // refunds: every handler parses data.object against its resource schema.
  const parsed = stripeChargeSchema.safeParse(envelope.data.object);
  if (!parsed.success) {
    return { code: "ignored-malformed-envelope", reason: "charge payload invalid" };
  }
  const charge = parsed.data;
  // We only ever issue *full* refunds from the app (createRefund sends no
  // amount). A teacher refunding partially from the Stripe dashboard fires
  // charge.refunded with `refunded: false` — treating that as a full
  // package refund would revoke all the student's remaining classes. Skip
  // anything that isn't an explicit full refund. (`refunded` undefined →
  // proceed, preserving prior behavior for payloads that omit the flag.)
  if (charge.refunded === false) {
    return { code: "noop", reason: "partial-refund-ignored" };
  }
  const paymentIntentId = charge.payment_intent ?? null;
  if (!paymentIntentId) {
    return { code: "noop", reason: "charge-refunded-without-pi" };
  }
  const payment = await deps.prisma.payment.findFirst({
    where: { providerPaymentId: paymentIntentId },
    include: {
      package: {
        select: { id: true, teacherId: true, studentId: true, templateId: true },
      },
    },
  });
  if (!payment) {
    return { code: "no-payment-row", clientReferenceId: null };
  }
  const now = (deps.now ?? (() => new Date()))();
  // A refund issued from the Stripe Dashboard debits the teacher's own balance
  // under direct charges, exactly as the in-app button does — no platform-held
  // transfer to claw back (D-143). We only record the transition.
  const outcome: StripeOutcomeInput = { kind: "refunded", paymentIntentId };
  return await applyTransition(payment, outcome, null, deps, now);
}

// ---------- shared transition + persistence ----------

type LoadedPayment = {
  id: string;
  status: import("@prisma/client").PaymentStatus;
  amountMinorUnits: number;
  currency: string;
  rail: import("@prisma/client").PaymentRail;
  providerPaymentId: string | null;
  paidAt: Date | null;
  refundedAt: Date | null;
  posthogSessionId: string | null;
  package: { id: string; teacherId: string; studentId: string; templateId: string | null };
};

async function applyTransition(
  payment: LoadedPayment,
  outcome: StripeOutcomeInput,
  sessionIdToRecord: string | null,
  deps: WebhookDeps,
  now: Date,
): Promise<WebhookOutcome> {
  const snapshot: PaymentSnapshot = {
    status: payment.status,
    amountMinorUnits: payment.amountMinorUnits,
    currency: payment.currency,
    rail: payment.rail,
    providerPaymentId: payment.providerPaymentId,
    paidAt: payment.paidAt,
    refundedAt: payment.refundedAt,
  };
  const result = advancePayment(snapshot, outcome, now);
  if (result.action === "noop") {
    if (sessionIdToRecord) {
      await deps.prisma.payment.update({
        where: { id: payment.id },
        data: { stripeCheckoutSessionId: sessionIdToRecord },
      });
    }
    return { code: "noop", reason: result.reason };
  }

  // Notification ids to fan out as Inngest events after the tx commits.
  // flip-paid     → 2 rows: payment_received (student) + payment_received_teacher
  // flip-failed   → 1 row: payment_failed_student
  // flip-refunded → 2 rows: refund_issued_student + refund_issued_teacher
  const queuedNotificationIds: string[] = [];
  let emitPaymentPaid = false;
  let emitCheckoutFailed = false;

  const lostRace = await deps.prisma.$transaction(async (tx) => {
    // Stripe delivers checkout.session.completed and payment_intent.succeeded
    // for the same purchase concurrently, to separate invocations. Both read
    // status='pending' before either commits and both compute the same flip.
    // Guard the write on the pre-read status (mirrors handleAccountUpdated) so
    // exactly one delivery applies the transition — and therefore activates the
    // package and enqueues the notifications exactly once. The loser matches 0
    // rows and bails as a noop.
    const flipped = await tx.payment.updateMany({
      where: { id: payment.id, status: payment.status },
      data: {
        status: result.next.status,
        rail: result.next.rail,
        providerPaymentId: result.next.providerPaymentId,
        paidAt: result.next.paidAt,
        refundedAt: result.next.refundedAt,
        ...(sessionIdToRecord ? { stripeCheckoutSessionId: sessionIdToRecord } : {}),
      },
    });
    if (flipped.count === 0) return true;
    if (result.action === "flip-paid") {
      await activatePackage(tx, payment.package.id, now);
      const id = await enqueuePaymentReceived(tx, {
        teacherId: payment.package.teacherId,
        studentId: payment.package.studentId,
        paymentId: payment.id,
        packageId: payment.package.id,
      });
      queuedNotificationIds.push(id);
      // Review item 7: without this the teacher only learns about a card
      // sale by checking the dashboard or Stripe.
      const teacherNoticeId = await enqueuePaymentReceivedTeacher(tx, {
        teacherId: payment.package.teacherId,
        paymentId: payment.id,
      });
      queuedNotificationIds.push(teacherNoticeId);
      emitPaymentPaid = true;
    } else if (result.action === "flip-failed") {
      const id = await enqueuePaymentFailedStudent(tx, {
        teacherId: payment.package.teacherId,
        studentId: payment.package.studentId,
        paymentId: payment.id,
      });
      queuedNotificationIds.push(id);
      emitCheckoutFailed = true;
    } else if (result.action === "flip-refunded") {
      await tx.package.update({
        where: { id: payment.package.id },
        data: { status: "refunded" },
      });
      // Slice 2b: void the referrer's reward if this payment had qualified a
      // referral and the reward is still unredeemed.
      await voidReferralRewardForPayment(tx, payment.id);
      const studentId = await enqueueRefundIssuedStudent(tx, {
        teacherId: payment.package.teacherId,
        studentId: payment.package.studentId,
        paymentId: payment.id,
      });
      queuedNotificationIds.push(studentId);
      const teacherId = await enqueueRefundIssuedTeacher(tx, {
        teacherId: payment.package.teacherId,
        paymentId: payment.id,
      });
      queuedNotificationIds.push(teacherId);
    }
    return false;
  });

  // A concurrent delivery already applied this transition — the guarded update
  // matched 0 rows, so no side effects ran here. Report a noop.
  if (lostRace) {
    return { code: "noop", reason: "already-transitioned" };
  }

  const emit = deps.emit;
  if (emit) {
    for (const notificationId of queuedNotificationIds) {
      try {
        await emit({
          name: "notification.queued",
          data: { notificationId, teacherId: payment.package.teacherId },
        });
      } catch (err) {
        log.error("emit notification.queued failed", err);
      }
    }
    if (emitPaymentPaid) {
      try {
        await emit({
          name: "payment.paid",
          data: {
            paymentId: payment.id,
            packageId: payment.package.id,
            teacherId: payment.package.teacherId,
            studentId: payment.package.studentId,
          },
        });
      } catch (err) {
        log.error("emit payment.paid failed", err);
      }
    }
  }

  if (emitPaymentPaid) {
    // Acquisition funnel terminal step (D-125), recorded AFTER the settlement
    // transaction committed — never inside it (see activatePackage). Inherits
    // the first-touch attribution captured at checkout, which is the only copy
    // that exists: a webhook arrives with no browser and no cookie.
    await recordPurchaseForActivation(payment.package.id);
    trackServerEvent({
      name: "payment_received",
      distinctId: payment.package.studentId,
      sessionId: payment.posthogSessionId ?? undefined,
      properties: {
        teacherId: payment.package.teacherId,
        packageId: payment.package.id,
        paymentId: payment.id,
        kind: "prepaid",
        amountMinorUnits: payment.amountMinorUnits,
        currency: payment.currency,
      },
    });
    await maybeEmitFirstPayment(deps.prisma, payment.package.teacherId, payment.id);
  }

  // Bottom-of-funnel drop-off: a card attempt that Stripe declined. Paired
  // with checkout_started (method='stripe'), this is the explicit "card
  // friction" signal feeding the OXXO/SPEI decision.
  if (emitCheckoutFailed) {
    trackServerEvent({
      name: "checkout_failed",
      distinctId: payment.package.studentId,
      sessionId: payment.posthogSessionId ?? undefined,
      properties: {
        teacherId: payment.package.teacherId,
        packageId: payment.package.id,
        paymentId: payment.id,
        rail: result.next.rail,
      },
    });
  }

  return {
    code: "applied",
    action: result.action,
    paymentId: payment.id,
    packageId: payment.package.id,
  };
}

// Pull the rail string from the PaymentIntent. Stripe surfaces it under
// `charges.data[0].payment_method_details.type` (legacy) or via the
// expanded `latest_charge.payment_method_details.type` (newer SDK).
// Our shape only carries the first; default to `null` and let
// normalizeRail collapse to 'unknown'.
function railFromPaymentIntent(pi: {
  charges?: { data: Array<{ payment_method_details?: { type?: string } | undefined }> };
  payment_method_types?: string[];
}): string | undefined {
  const fromCharge = pi.charges?.data?.[0]?.payment_method_details?.type;
  if (fromCharge) return fromCharge;
  // Fallback: the request's allowed methods. If only one was offered we
  // can infer; otherwise leave undefined.
  const types = pi.payment_method_types ?? [];
  return types.length === 1 ? types[0] : undefined;
}
