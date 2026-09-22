import type {
  PrismaClient,
  SubscriptionInvoiceStatus,
  SubscriptionPaymentProvider,
} from "@prisma/client";
import {
  enqueueSubscriptionCanceled,
  enqueueSubscriptionFoundingPriceLocked,
  enqueueSubscriptionPaymentFailed,
  enqueueSubscriptionPaymentSucceeded,
} from "@/lib/notifications/enqueue";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { currencyForRegion } from "@spiralclass/shared";
import { PAST_DUE_GRACE_DAYS, isPaidPlan, type SubscriptionPlan } from "./config";
import { logger } from "@/lib/logger";

const log = logger({ surface: "subscriptions" });

// Subscription lifecycle transitions. THE single place that mutates the
// teacher_subscriptions row's plan/status, records invoice rows, drives the
// founding headcount, and fans out the notification + analytics side effects.
// Called from the billing webhook handler and the Inngest trial/grace sweeps,
// all under the service role. Keep these idempotent — webhooks and sweeps can
// re-fire the same transition.

export type LifecycleEmitter = (event: {
  name: "notification.queued";
  data: { notificationId: string; teacherId: string };
}) => Promise<void>;

export type LifecycleDeps = {
  prisma: PrismaClient;
  emit?: LifecycleEmitter;
  now?: () => Date;
};

async function fireNotification(
  deps: LifecycleDeps,
  notificationId: string | null,
  teacherId: string,
): Promise<void> {
  if (!notificationId || !deps.emit) return;
  try {
    await deps.emit({ name: "notification.queued", data: { notificationId, teacherId } });
  } catch (err) {
    // Never let an analytics/notification emit failure break the transition.
    log.warn("emit notification.queued failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Activate (or keep active) a teacher's subscription. Sets plan + locked price +
// Stripe ids + period end, flips status to active, and — for a founding plan —
// bumps the cohort headcount and sends the price-locked confirmation. Idempotent.
export async function activateSubscription(
  deps: LifecycleDeps,
  input: {
    teacherId: string;
    plan: SubscriptionPlan;
    lockedPriceMinorUnits: number;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    currentPeriodEnd?: Date | null;
    // Stripe's `cancel_at_period_end`. Written UNCONDITIONALLY (unlike the
    // optional fields around it) whenever the caller supplies it, because the
    // value that matters most is the flip back to `false` when a teacher
    // resumes — a "only write when truthy" spread would leave her looking
    // cancelled forever.
    cancelAtPeriodEnd?: boolean;
    comped?: boolean;
    // Billing currency for this subscription. Callers should pass the real
    // currency off the Stripe subscription/invoice object; the platform
    // region is only a fallback for when there's no live Stripe object to read
    // one from (see billing-webhook-handler.ts).
    currency?: string;
    // VAT/GST readiness (global-launch item 7): the billing country + address
    // captured off the platform Customer. Only written when present, so a later
    // event without an address never nulls a previously-captured value.
    billingCountry?: string | null;
    billingAddressJson?: Record<string, string> | null;
  },
): Promise<void> {
  const prior = await deps.prisma.teacherSubscription.findUnique({
    where: { teacherId: input.teacherId },
    select: { status: true },
  });
  const wasActive = prior?.status === "active";
  // Fallback only (every real caller passes input.currency from the live
  // Stripe object) — the platform-region default, never hardcoded.
  let currency = input.currency;
  if (!currency) {
    const teacherRow = await deps.prisma.teacher.findUnique({
      where: { id: input.teacherId },
      select: { platformRegion: true },
    });
    currency = currencyForRegion(teacherRow?.platformRegion);
  }

  // Billing capture (VAT/GST readiness): only include the fields when present,
  // in BOTH the create and the update path, so a later activation lacking an
  // address never overwrites one captured earlier.
  const billingData = {
    ...(input.billingCountry ? { billingCountry: input.billingCountry } : {}),
    ...(input.billingAddressJson ? { billingAddressJson: input.billingAddressJson } : {}),
  };

  let foundingNotifId: string | null = null;
  let becameFounding = false;
  await deps.prisma.$transaction(async (tx) => {
    const createData = {
      teacherId: input.teacherId,
      plan: input.plan,
      status: "active" as const,
      lockedPriceMinorUnits: input.lockedPriceMinorUnits,
      currency,
      stripeCustomerId: input.stripeCustomerId ?? null,
      stripeSubscriptionId: input.stripeSubscriptionId ?? null,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
      comped: input.comped ?? false,
      trialEndsAt: null,
      ...billingData,
    };
    const updateData = {
      plan: input.plan,
      status: "active" as const,
      lockedPriceMinorUnits: input.lockedPriceMinorUnits,
      currency,
      ...(input.stripeCustomerId ? { stripeCustomerId: input.stripeCustomerId } : {}),
      ...(input.stripeSubscriptionId ? { stripeSubscriptionId: input.stripeSubscriptionId } : {}),
      ...(input.currentPeriodEnd ? { currentPeriodEnd: input.currentPeriodEnd } : {}),
      ...(input.cancelAtPeriodEnd !== undefined
        ? { cancelAtPeriodEnd: input.cancelAtPeriodEnd }
        : {}),
      ...(input.comped !== undefined ? { comped: input.comped } : {}),
      canceledAt: null,
      trialEndsAt: null,
      ...billingData,
    };

    // The founding headcount must bump exactly once per teacher's transition
    // INTO founding. Detecting that transition from a pre-transaction read
    // raced: two concurrent webhook deliveries (e.g. subscription.created and
    // invoice.paid) both saw a stale non-founding plan and both incremented.
    // Detect it atomically instead: only the caller whose conditional update
    // actually moved the row off a non-founding plan performs the bump.
    // (A concurrent first-ever create loses on the unique constraint and the
    // webhook redelivers — acceptable for that vanishingly rare case.)
    const existing = await tx.teacherSubscription.findUnique({
      where: { teacherId: input.teacherId },
      select: { teacherId: true },
    });
    if (!existing) {
      await tx.teacherSubscription.create({ data: createData });
      becameFounding = input.plan === "founding";
    } else if (input.plan === "founding") {
      const flip = await tx.teacherSubscription.updateMany({
        where: { teacherId: input.teacherId, NOT: { plan: "founding" } },
        data: updateData,
      });
      becameFounding = flip.count === 1;
      if (!becameFounding) {
        // Already founding — still sync the rest of the fields.
        await tx.teacherSubscription.update({
          where: { teacherId: input.teacherId },
          data: updateData,
        });
      }
    } else {
      await tx.teacherSubscription.update({
        where: { teacherId: input.teacherId },
        data: updateData,
      });
    }

    if (becameFounding) {
      await tx.foundingCohort.upsert({
        where: { id: "default" },
        create: { id: "default", headcount: 1 },
        update: { headcount: { increment: 1 } },
      });
      foundingNotifId = await enqueueSubscriptionFoundingPriceLocked(tx, {
        teacherId: input.teacherId,
        amountMinorUnits: input.lockedPriceMinorUnits,
        // The same currency written to the subscription row above, so the
        // locked-price email quotes the price she was actually locked at.
        currency,
      });
    }
  });

  await fireNotification(deps, foundingNotifId, input.teacherId);

  // Analytics: emit activation once (on the transition into active), plus the
  // founding-lock event on the transition into founding.
  if (!wasActive) {
    const planProp = input.plan === "free" ? "monthly" : input.plan;
    trackServerEvent({
      name: "subscription_activated",
      distinctId: input.teacherId,
      properties: {
        teacherId: input.teacherId,
        plan: planProp,
        comped: input.comped ?? false,
      },
    });
    // Free→paid funnel terminal event (skip comped — not a self-serve upgrade).
    if (!input.comped) {
      trackServerEvent({
        name: "upgraded",
        distinctId: input.teacherId,
        properties: { teacherId: input.teacherId, plan: planProp },
      });
    }
  }
  if (becameFounding) {
    trackServerEvent({
      name: "founding_price_locked",
      distinctId: input.teacherId,
      properties: { teacherId: input.teacherId, priceMinorUnits: input.lockedPriceMinorUnits },
    });
  }
}

// Move into the 7-day past_due grace window (full Pro kept; persistent "update
// payment" banner). Idempotent. Sends the payment-failed notice.
//
// The grace window is anchored on `currentPeriodEnd` (see effectiveStatus:
// graceEnd = currentPeriodEnd + PAST_DUE_GRACE_DAYS). That anchor MUST stay the
// teacher's paid-through date — the end of the last SUCCESSFULLY paid period —
// so grace runs ~7 days from the failed renewal. A failed renewal's invoice /
// subscription carries the end of the UNPAID period (roughly a full cycle in
// the future, because Stripe advances current_period_end when it opens the
// renewal invoice); anchoring on that would silently extend full Pro (and the
// reduced marketplace-commission tier) for an extra billing cycle AND make the
// daily sweep's `currentPeriodEnd <= now - 7d` drop condition unreachable.
// So callers pass NO currentPeriodEnd here and we preserve the existing
// paid-through value; the `now` fallback only bounds the (shouldn't-happen)
// case where no prior period end was ever recorded, keeping grace finite
// instead of indefinite.
export async function markPastDue(
  deps: LifecycleDeps,
  input: { teacherId: string; currentPeriodEnd?: Date | null },
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  let notifId: string | null = null;
  let applied = false;
  await deps.prisma.$transaction(async (tx) => {
    const existing = await tx.teacherSubscription.findUnique({
      where: { teacherId: input.teacherId },
      select: { status: true, currentPeriodEnd: true },
    });
    if (!existing) return;
    // past_due (the grace window) only makes sense from a live paid state.
    // A late/out-of-order failed-payment webhook for a teacher who already
    // canceled or dropped to free must not flip them to past_due — that
    // status re-grants full Pro (indefinitely when currentPeriodEnd is null).
    if (
      existing.status !== "active" &&
      existing.status !== "trialing" &&
      existing.status !== "past_due"
    ) {
      return;
    }
    applied = true;
    // Already in the grace window: the paid-through anchor is preserved (a
    // no-op write) and we never re-notify. Short-circuit before the guarded
    // flip below so a repeat failed-payment webhook stays a notice-free no-op.
    if (existing.status === "past_due") {
      return;
    }
    // Preserve the paid-through anchor. Only an explicit caller-supplied value
    // (none do today) overrides it; otherwise keep the prior period end, and
    // fall back to `now` only when there is none — never the future unpaid end.
    const graceAnchor = input.currentPeriodEnd ?? existing.currentPeriodEnd ?? now;
    // Transition INTO past_due ATOMICALLY, guarded on the prior live status.
    // A single failed renewal makes Stripe fire TWO separate webhook events —
    // `invoice.payment_failed` AND `customer.subscription.updated` (status
    // past_due/unpaid) — each claimed under its own event id and therefore
    // processed CONCURRENTLY. A plain pre-read + unconditional update let both
    // deliveries observe the same "active" status and both enqueue a
    // `subscription_payment_failed` notice, double-emailing the teacher. Only
    // the delivery whose conditional flip actually matches the prior live
    // status performs the transition (and notifies); the loser's updateMany
    // affects 0 rows. Mirrors handleAccountUpdated / the payment webhook.
    const flip = await tx.teacherSubscription.updateMany({
      where: { teacherId: input.teacherId, status: { in: ["active", "trialing"] } },
      data: {
        status: "past_due",
        currentPeriodEnd: graceAnchor,
      },
    });
    // Lost the race — a concurrent delivery already flipped us into past_due.
    // Treat it exactly like the already-past_due case: no duplicate notice.
    if (flip.count === 0) {
      return;
    }
    notifId = await enqueueSubscriptionPaymentFailed(tx, {
      teacherId: input.teacherId,
      graceDays: PAST_DUE_GRACE_DAYS,
    });
  });
  if (!applied) return;
  await fireNotification(deps, notifId, input.teacherId);
  trackServerEvent({
    name: "subscription_payment_failed",
    distinctId: input.teacherId,
    properties: { teacherId: input.teacherId },
  });
}

// Drop the teacher to the Free tier. NEVER deletes data: students, packages,
// and templates stay; the teacher just can't add new ones past the Free caps
// until they upgrade. Sends the canceled/downgraded notice.
// Idempotent (a no-op if already free).
export async function dropToFree(
  deps: LifecycleDeps,
  input: {
    teacherId: string;
    reason: "trial_expired" | "past_due_grace_elapsed" | "canceled";
  },
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  let notifId: string | null = null;
  let didDrop = false;
  await deps.prisma.$transaction(async (tx) => {
    const existing = await tx.teacherSubscription.findUnique({
      where: { teacherId: input.teacherId },
      select: { status: true, comped: true },
    });
    if (!existing) return;
    // Comped teachers are never dropped — full Pro for life.
    if (existing.comped) return;
    if (existing.status === "free") return;
    didDrop = true;
    await tx.teacherSubscription.update({
      where: { teacherId: input.teacherId },
      data: {
        status: "free",
        plan: "free",
        lockedPriceMinorUnits: null,
        // The pending-cancellation flag has served its purpose the moment the
        // subscription actually ends; leaving it set would make a Free teacher
        // read as "cancelling".
        cancelAtPeriodEnd: false,
        canceledAt: input.reason === "canceled" ? now : undefined,
      },
    });
    notifId = await enqueueSubscriptionCanceled(tx, { teacherId: input.teacherId });
  });
  if (!didDrop) return;
  await fireNotification(deps, notifId, input.teacherId);
  trackServerEvent({
    name: "downgraded_to_free",
    distinctId: input.teacherId,
    properties: { teacherId: input.teacherId, reason: input.reason },
  });
  if (input.reason === "canceled") {
    trackServerEvent({
      name: "subscription_canceled",
      distinctId: input.teacherId,
      properties: { teacherId: input.teacherId },
    });
  }
}

// Record (upsert) a subscription invoice row, idempotent on stripeInvoiceId.
// netMinorUnits is persisted explicitly (amount − fee) — the commission base.
export async function recordSubscriptionInvoice(
  deps: LifecycleDeps,
  input: {
    teacherId: string;
    stripeInvoiceId?: string | null;
    manualPaymentRef?: string | null;
    amountMinorUnits: number;
    feeMinorUnits: number;
    // ISO-4217 settlement currency of the invoice. Real callers always pass
    // Stripe's own invoice.currency; the default below is a last-resort for
    // the (shouldn't-happen) case where it's missing.
    currency?: string;
    periodStart: Date;
    periodEnd: Date;
    status: SubscriptionInvoiceStatus;
    // Billing's own enum, not the payout rail's (D-113 split them).
    provider?: SubscriptionPaymentProvider;
    paidAt?: Date | null;
  },
): Promise<void> {
  // Commission net is defined as amount_paid minus the Stripe processing fee
  // ONLY. This is deliberately NOT the balance transaction's bt.net: IVA and
  // any other balance-transaction adjustments are intentionally excluded from
  // the commission base. amount − fee is the figure we commission on; do not
  // "fix" this to read bt.net.
  const netMinorUnits = input.amountMinorUnits - input.feeMinorUnits;
  const data = {
    teacherId: input.teacherId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    amountMinorUnits: input.amountMinorUnits,
    feeMinorUnits: input.feeMinorUnits,
    netMinorUnits,
    currency: input.currency ?? "GBP",
    status: input.status,
    provider: input.provider ?? "stripe",
    manualPaymentRef: input.manualPaymentRef ?? null,
    paidAt: input.paidAt ?? null,
  };
  if (input.stripeInvoiceId) {
    await deps.prisma.subscriptionInvoice.upsert({
      where: { stripeInvoiceId: input.stripeInvoiceId },
      create: { ...data, stripeInvoiceId: input.stripeInvoiceId },
      update: {
        status: input.status,
        feeMinorUnits: input.feeMinorUnits,
        netMinorUnits,
        paidAt: input.paidAt ?? null,
      },
    });
  } else {
    await deps.prisma.subscriptionInvoice.create({ data });
  }
}

// Send the post-payment receipt. Separate so the webhook can fire it after the
// invoice + activation are persisted.
export async function notifyPaymentSucceeded(
  deps: LifecycleDeps,
  input: {
    teacherId: string;
    amountMinorUnits: number;
    // Stripe's own invoice currency. The receipt must state the currency she
    // was charged in — GBP since D-99, MXN for a pre-D-99 subscriber — and
    // never a re-derived one.
    currency: string;
    nextChargeAt: Date | null;
  },
): Promise<void> {
  let notifId: string | null = null;
  await deps.prisma.$transaction(async (tx) => {
    notifId = await enqueueSubscriptionPaymentSucceeded(tx, input);
  });
  await fireNotification(deps, notifId, input.teacherId);
}

export { isPaidPlan };
