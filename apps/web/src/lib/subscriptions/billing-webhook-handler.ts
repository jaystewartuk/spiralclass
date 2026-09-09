import type { PrismaClient } from "@prisma/client";
import type { StripeClient } from "@/lib/stripe";
import {
  stripeInvoiceSchema,
  stripeSubscriptionSchema,
  stripeWebhookEnvelopeSchema,
  type StripeSubscription,
} from "@/lib/stripe/types";
import { currencyForRegion } from "@spiralclass/shared";
import { capturedBillingFromAddress, type CapturedBilling } from "@/lib/stripe/billing-address";
import { planPriceMinorUnits, planForStripePriceId, type SubscriptionPlan } from "./config";
import { getFoundingCohortState } from "./service";
import {
  activateSubscription,
  dropToFree,
  markPastDue,
  notifyPaymentSucceeded,
  recordSubscriptionInvoice,
  type LifecycleEmitter,
} from "./lifecycle";
import { logger } from "@/lib/logger";

const log = logger({ surface: "billing-webhook" });

// Stripe BILLING webhook handler — SEPARATE from the Connect webhook handler.
// Handles the teacher's own platform subscription:
//   customer.subscription.created / .updated / .deleted
//   invoice.paid / invoice.payment_failed
// signature-verified with its own secret (STRIPE_BILLING_WEBHOOK_SECRET) and
// idempotent via WebhookEvent. It drives the lifecycle transitions in
// lifecycle.ts. Do NOT entangle it with the Connect account.updated handler.

export type BillingWebhookDeps = {
  prisma: PrismaClient;
  stripe: StripeClient;
  emit?: LifecycleEmitter;
  now?: () => Date;
  priceIds: { monthly?: string; annual?: string; founding?: string };
};

export type BillingWebhookOutcome =
  | { code: "ignored-unhandled-type"; type: string }
  | { code: "ignored-malformed-envelope"; reason: string }
  | { code: "no-teacher"; reason: string }
  | { code: "applied"; action: string; teacherId: string };

export async function handleBillingWebhook(
  raw: unknown,
  deps: BillingWebhookDeps,
): Promise<BillingWebhookOutcome> {
  const parsed = stripeWebhookEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      code: "ignored-malformed-envelope",
      reason: parsed.error.issues[0]?.message ?? "unparseable",
    };
  }
  const envelope = parsed.data;
  switch (envelope.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return handleSubscriptionChanged(envelope.data.object, deps);
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(envelope.data.object, deps);
    case "invoice.paid":
      return handleInvoicePaid(envelope.data.object, deps);
    case "invoice.payment_failed":
      return handleInvoicePaymentFailed(envelope.data.object, deps);
    default:
      return { code: "ignored-unhandled-type", type: envelope.type };
  }
}

// Who a Stripe billing object says it belongs to.
//
// Since D-143 the teacher's own v2 `Account` IS the billing customer, so a new
// subscription or invoice carries `customer_account: acct_…`; one created
// before the cutover carries `customer: cus_…`. Both land in the same
// `teacher_subscriptions.stripe_customer_id` column, so both resolve through
// the same lookup and neither needs a migration.
//
// Reading only `customer` — as this did before the rebuild — would silently
// fail to resolve EVERY new subscriber, and the failure looks like
// "no-teacher" rather than like a bug.
function billingIdOf(obj: {
  customer?: string | null;
  customer_account?: string | null;
}): string | null {
  return obj.customer_account ?? obj.customer ?? null;
}

// Resolve our teacher id from that billing id (the canonical link is
// teacher_subscriptions.stripeCustomerId), falling back to a metadata.teacher_id
// hint set on the subscription at checkout.
async function resolveTeacherId(
  deps: BillingWebhookDeps,
  input: { customerId: string | null | undefined; metadataTeacherId?: string | null },
): Promise<string | null> {
  if (input.customerId) {
    const sub = await deps.prisma.teacherSubscription.findFirst({
      where: { stripeCustomerId: input.customerId },
      select: { teacherId: true },
    });
    if (sub) return sub.teacherId;
  }
  if (input.metadataTeacherId) {
    const teacher = await deps.prisma.teacher.findUnique({
      where: { id: input.metadataTeacherId },
      select: { id: true },
    });
    if (teacher) return teacher.id;
  }
  return null;
}

function planFromSubscription(
  sub: StripeSubscription,
  deps: BillingWebhookDeps,
): SubscriptionPlan | null {
  const priceId = sub.items?.data?.[0]?.price?.id;
  return planForStripePriceId(priceId, deps.priceIds);
}

function unixToDate(unix: number | null | undefined): Date | null {
  return unix ? new Date(unix * 1000) : null;
}

// The injected clock, or the real one. Named because three call sites had this
// same expression inline.
function nowOf(deps: BillingWebhookDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

// VAT/GST readiness (global-launch item 7): read the billing address the
// subscription Checkout wrote back onto the platform Customer
// (`customer_update[address]=auto`) so it's persisted alongside the
// subscription. Best-effort — a fetch failure (or an unseeded customer in a
// test) never blocks activation; we simply capture nothing this delivery.
async function captureCustomerBilling(
  deps: BillingWebhookDeps,
  customerId: string | null | undefined,
): Promise<CapturedBilling | null> {
  if (!customerId) return null;
  // Only a platform Customer has an address written back by
  // `customer_update[address]=auto`. A v2 Account holds its own identity and is
  // not retrievable through the Customers API, so asking would 404 on every
  // delivery for every teacher billed since D-143 — noisy, and pointlessly so.
  // Capturing nothing is the honest outcome until the VAT work reads identity
  // off the Account instead.
  if (customerId.startsWith("acct_")) return null;
  try {
    const customer = await deps.stripe.getBillingCustomer(customerId);
    return capturedBillingFromAddress(customer.address);
  } catch (err) {
    log.warn("billing address capture failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// A founding teacher's original locked price survives renewals — but only
// when they were ALREADY founding. Inheriting the locked price of a prior
// monthly/annual plan would "lock" a new founding member at the wrong
// (higher) price.
function foundingLockedPrice(
  plan: SubscriptionPlan,
  existing: { plan: SubscriptionPlan; lockedPriceMinorUnits: number | null } | null,
  currency: string = "GBP",
): number {
  return plan === "founding" && existing?.plan === "founding" && existing.lockedPriceMinorUnits
    ? existing.lockedPriceMinorUnits
    : planPriceMinorUnits(plan, currency);
}

// Fallback only: the platform-region-derived currency, used when there's no
// live Stripe subscription/invoice object to read a real currency off of (the
// canonical source — see the callers below). Kept for the rare edge case,
// never the primary path for an active subscriber.
async function billingCurrencyForTeacher(
  deps: BillingWebhookDeps,
  teacherId: string,
): Promise<string> {
  const teacher = await deps.prisma.teacher.findUnique({
    where: { id: teacherId },
    select: { platformRegion: true },
  });
  return currencyForRegion(teacher?.platformRegion);
}

async function handleSubscriptionChanged(
  object: unknown,
  deps: BillingWebhookDeps,
): Promise<BillingWebhookOutcome> {
  const parsed = stripeSubscriptionSchema.safeParse(object);
  if (!parsed.success) {
    return { code: "ignored-malformed-envelope", reason: "subscription payload invalid" };
  }
  // Re-fetch canonical state from Stripe (never trust the payload).
  const sub = await deps.stripe.getSubscription(parsed.data.id);
  const teacherId = await resolveTeacherId(deps, {
    customerId: billingIdOf(sub),
    metadataTeacherId: sub.metadata?.teacher_id ?? null,
  });
  if (!teacherId) {
    return { code: "no-teacher", reason: `unresolved customer ${billingIdOf(sub)}` };
  }

  const existing = await deps.prisma.teacherSubscription.findUnique({
    where: { teacherId },
    select: { plan: true, lockedPriceMinorUnits: true },
  });
  const plan = planFromSubscription(sub, deps) ?? existing?.plan ?? null;
  const periodEnd = unixToDate(sub.current_period_end);

  switch (sub.status) {
    case "active":
    case "trialing": {
      if (!plan || plan === "free") {
        return { code: "no-teacher", reason: "unknown plan price" };
      }
      // The Stripe subscription's OWN currency — never re-derived from our
      // platform-region config. That's what lets the platform's canonical
      // billing currency change (D-99: MXN → GBP) without this webhook
      // silently reinterpreting an already-live MXN subscriber's next renewal
      // as if it were GBP: their Stripe subscription is still actually on the
      // MXN Price it was created with, and Stripe reports that truthfully.
      const currency = sub.currency.toUpperCase();

      // The founding cohort is OUR rule, and this is the only place it can be
      // enforced against a subscription that changed outside checkout.
      //
      // The Customer Portal can switch a subscriber's price, and the portal
      // configuration excludes the founding price precisely so she cannot put
      // herself on it — past the cap, past the cutoff, and permanently, since
      // founding is price-locked for life. But that exclusion lives in Stripe's
      // configuration: a Dashboard edit changes it, and the API does not echo
      // the field back, so it cannot be verified by reading. A rule worth
      // having is worth enforcing where we control it.
      //
      // Detect only — never rewrite. The subscription really is on that price
      // at Stripe, so recording anything else would make our row disagree with
      // what she is actually charged, which is a worse failure than the one
      // being guarded. Loud enough to act on instead.
      if (plan === "founding" && existing?.plan !== "founding") {
        const cohort = await getFoundingCohortState(nowOf(deps), deps.prisma);
        if (!cohort.isOpen) {
          log.error("founding plan granted while the cohort is closed", {
            teacherId,
            subscriptionId: sub.id,
            headcount: cohort.headcount,
            cap: cohort.cap,
          });
        }
      }

      const lockedPrice = foundingLockedPrice(plan, existing, currency);
      const billing = await captureCustomerBilling(deps, billingIdOf(sub));
      await activateSubscription(deps, {
        teacherId,
        plan,
        lockedPriceMinorUnits: lockedPrice,
        stripeCustomerId: billingIdOf(sub) ?? undefined,
        stripeSubscriptionId: sub.id,
        currentPeriodEnd: periodEnd,
        // A portal cancellation arrives as customer.subscription.updated with
        // the status still `active` — this flag is the ONLY thing in the
        // payload that distinguishes it from an ordinary renewal, and it was
        // parsed and discarded until now. `?? false` rather than a passthrough
        // of undefined: Stripe omits the field on a subscription that is not
        // cancelling, and "absent" means "not cancelling", not "unknown".
        cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
        currency,
        billingCountry: billing?.billingCountry ?? null,
        billingAddressJson: billing?.billingAddressJson ?? null,
      });
      return { code: "applied", action: `subscription-${sub.status}`, teacherId };
    }
    case "past_due":
    case "unpaid": {
      // Do NOT pass the subscription's current_period_end here: on a failed
      // renewal Stripe has already advanced it to the END of the unpaid period
      // (~a full cycle out). markPastDue anchors the 7-day grace on the stored
      // (paid-through) period end, so passing the future value would extend Pro
      // for an extra billing cycle and defeat the sweep's drop condition.
      await markPastDue(deps, { teacherId });
      return { code: "applied", action: "subscription-past-due", teacherId };
    }
    case "canceled": {
      await dropToFree(deps, { teacherId, reason: "canceled" });
      return { code: "applied", action: "subscription-canceled", teacherId };
    }
    default:
      // incomplete / incomplete_expired / paused — nothing to apply yet.
      return { code: "applied", action: `subscription-noop-${sub.status}`, teacherId };
  }
}

async function handleSubscriptionDeleted(
  object: unknown,
  deps: BillingWebhookDeps,
): Promise<BillingWebhookOutcome> {
  const parsed = stripeSubscriptionSchema.safeParse(object);
  if (!parsed.success) {
    return { code: "ignored-malformed-envelope", reason: "subscription payload invalid" };
  }
  const teacherId = await resolveTeacherId(deps, {
    customerId: billingIdOf(parsed.data),
    metadataTeacherId: parsed.data.metadata?.teacher_id ?? null,
  });
  if (!teacherId) {
    return { code: "no-teacher", reason: `unresolved customer ${billingIdOf(parsed.data)}` };
  }
  await dropToFree(deps, { teacherId, reason: "canceled" });
  return { code: "applied", action: "subscription-deleted", teacherId };
}

async function handleInvoicePaid(
  object: unknown,
  deps: BillingWebhookDeps,
): Promise<BillingWebhookOutcome> {
  const parsed = stripeInvoiceSchema.safeParse(object);
  if (!parsed.success) {
    return { code: "ignored-malformed-envelope", reason: "invoice payload invalid" };
  }
  const invoice = parsed.data;
  const teacherId = await resolveTeacherId(deps, { customerId: billingIdOf(invoice) });
  if (!teacherId) {
    return { code: "no-teacher", reason: `unresolved customer ${billingIdOf(invoice)}` };
  }

  const amountMinorUnits = invoice.amount_paid ?? invoice.total ?? 0;
  // Stripe's own invoice currency, resolved once for the whole handler: the
  // invoice row, the activation, and the receipt email must all state the
  // currency she was actually charged in rather than each deriving its own.
  const invoiceCurrency =
    invoice.currency?.toUpperCase() ?? (await billingCurrencyForTeacher(deps, teacherId));
  // Read the platform's real Stripe fee from the charge's balance transaction.
  // The commission base is amount − fee (see recordSubscriptionInvoice), so a
  // fee we fail to read would silently record net = gross and over-pay the
  // ambassador commission — permanently, since the event is marked processed.
  // The balance transaction can briefly lag the invoice.paid event (the same
  // lag the teacher-payout path treats as retryable in transfer.ts). So on a
  // paid invoice that has a payment_intent, an unreadable fee THROWS to force
  // the webhook retry rather than committing a wrong net; the route releases
  // the idempotency claim on throw so Stripe re-delivers and we reprocess.
  // A zero-amount invoice (fully discounted / trial) has no payment_intent and
  // legitimately carries no processing fee.
  let feeMinorUnits = 0;
  if (invoice.payment_intent) {
    const settled = await deps.stripe.getSettledCharge(invoice.payment_intent);
    if (!settled) {
      throw new Error(`billing-fee-not-settled-yet:${invoice.payment_intent}`);
    }
    feeMinorUnits = settled.feeMinorUnits ?? 0;
  }
  const now = (deps.now ?? (() => new Date()))();
  const periodStart = unixToDate(invoice.period_start) ?? now;
  const periodEnd = unixToDate(invoice.period_end) ?? now;

  await recordSubscriptionInvoice(deps, {
    teacherId,
    stripeInvoiceId: invoice.id,
    amountMinorUnits,
    feeMinorUnits,
    currency: invoiceCurrency,
    periodStart,
    periodEnd,
    status: "paid",
    provider: "stripe",
    paidAt: now,
  });

  // Ensure the subscription is active (the invoice.paid event can land before
  // customer.subscription.updated). Resolve the plan from the linked
  // subscription when present.
  if (invoice.subscription) {
    try {
      const sub = await deps.stripe.getSubscription(invoice.subscription);
      const existing = await deps.prisma.teacherSubscription.findUnique({
        where: { teacherId },
        select: { plan: true, lockedPriceMinorUnits: true },
      });
      const plan = planFromSubscription(sub, deps) ?? existing?.plan ?? null;
      // Mirror handleSubscriptionChanged's status switch: Stripe does not
      // guarantee delivery order, so a late/redelivered invoice.paid can land
      // AFTER customer.subscription.deleted dropped the teacher to free.
      // Activating without checking the re-fetched status re-granted Pro to a
      // canceled subscription — and nothing would ever correct it (no future
      // webhook fires for a canceled sub, and the sweep only touches
      // trialing/past_due rows).
      const isLive = sub.status === "active" || sub.status === "trialing";
      if (plan && plan !== "free" && isLive) {
        const lockedPrice = foundingLockedPrice(plan, existing, invoiceCurrency);
        await activateSubscription(deps, {
          teacherId,
          plan,
          lockedPriceMinorUnits: lockedPrice,
          stripeCustomerId: billingIdOf(invoice) ?? undefined,
          stripeSubscriptionId: sub.id,
          currentPeriodEnd: unixToDate(sub.current_period_end),
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
          currency: invoiceCurrency,
        });
      }
    } catch (err) {
      log.warn("subscription sync on invoice.paid failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await notifyPaymentSucceeded(deps, {
    teacherId,
    amountMinorUnits,
    currency: invoiceCurrency,
    nextChargeAt: periodEnd,
  });

  return { code: "applied", action: "invoice-paid", teacherId };
}

async function handleInvoicePaymentFailed(
  object: unknown,
  deps: BillingWebhookDeps,
): Promise<BillingWebhookOutcome> {
  const parsed = stripeInvoiceSchema.safeParse(object);
  if (!parsed.success) {
    return { code: "ignored-malformed-envelope", reason: "invoice payload invalid" };
  }
  const invoice = parsed.data;
  const teacherId = await resolveTeacherId(deps, { customerId: billingIdOf(invoice) });
  if (!teacherId) {
    return { code: "no-teacher", reason: `unresolved customer ${billingIdOf(invoice)}` };
  }
  const now = (deps.now ?? (() => new Date()))();
  await recordSubscriptionInvoice(deps, {
    teacherId,
    stripeInvoiceId: invoice.id,
    amountMinorUnits: invoice.amount_due ?? invoice.total ?? 0,
    feeMinorUnits: 0,
    currency: invoice.currency?.toUpperCase(),
    periodStart: unixToDate(invoice.period_start) ?? now,
    periodEnd: unixToDate(invoice.period_end) ?? now,
    status: "failed",
    provider: "stripe",
  });
  // No currentPeriodEnd: invoice.period_end is the END of the UNPAID period
  // (~a full cycle out). markPastDue keeps the stored paid-through anchor so the
  // 7-day grace runs from the failed renewal, not a cycle later. (See markPastDue.)
  await markPastDue(deps, { teacherId });
  return { code: "applied", action: "invoice-payment-failed", teacherId };
}
