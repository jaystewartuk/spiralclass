import { z } from "zod";

// Subset of Stripe API shapes we actually consume. Full schemas live in
// Stripe's docs; here we validate only what the webhook handler, checkout
// action, and Connect onboarding read so a typo surfaces as a Zod error
// rather than a runtime undefined.

// ---------------- Connect (Account, AccountLink) ----------------

export const stripeAccountSchema = z.object({
  id: z.string(), // acct_xxx
  charges_enabled: z.boolean(),
  payouts_enabled: z.boolean(),
  details_submitted: z.boolean().optional(),
  // Reflects requirements + capability state. We only read the booleans
  // above for gating; the rest is surfaced for diagnostics.
  requirements: z
    .object({
      currently_due: z.array(z.string()).optional(),
      eventually_due: z.array(z.string()).optional(),
      disabled_reason: z.string().nullable().optional(),
    })
    .partial()
    .optional(),
});
export type StripeAccount = z.infer<typeof stripeAccountSchema>;

// The Accounts v2 create response (D-143). Deliberately minimal: the only
// thing this call needs from it is the id, because every READ in the codebase
// goes through the v1 endpoint — Stripe serves a v2 account in the v1 shape, so
// `stripeAccountSchema` above stays the one type the rest of the app knows.
// `applied_configurations` is validated too, as a cheap assertion that the
// account really came back with both roles rather than silently one.
export const stripeV2AccountSchema = z.object({
  id: z.string(), // acct_xxx
  object: z.literal("v2.core.account").optional(),
  applied_configurations: z.array(z.string()).optional(),
});
export type StripeV2Account = z.infer<typeof stripeV2AccountSchema>;

export const stripeAccountLinkSchema = z.object({
  url: z.string().url(),
  expires_at: z.number().optional(),
});
export type StripeAccountLink = z.infer<typeof stripeAccountLinkSchema>;

// Account Session — powers Stripe Connect embedded components
// (@stripe/react-connect-js) rendered inline instead of a hosted-page
// redirect. client_secret is single-use/short-lived; a fresh one is minted
// per page load via the fetchClientSecret callback Connect.js calls.
export const stripeAccountSessionSchema = z.object({
  client_secret: z.string(),
});
export type StripeAccountSession = z.infer<typeof stripeAccountSessionSchema>;

// ---------------- Address (billing / tax) ----------------

// Stripe's address shape, shared by a Checkout Session's `customer_details`
// and by a Customer. Every field is nullable/optional — Stripe omits blanks.
// Captured for VAT/GST readiness (global-launch item 7); see billing-address.ts.
export const stripeAddressSchema = z.object({
  line1: z.string().nullable().optional(),
  line2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  postal_code: z.string().nullable().optional(),
  // ISO-3166-1 alpha-2, uppercase (e.g. "MX", "GB").
  country: z.string().nullable().optional(),
});
export type StripeAddress = z.infer<typeof stripeAddressSchema>;

// ---------------- Checkout Session ----------------

export const stripeCheckoutSessionStatusSchema = z.enum(["open", "complete", "expired"]);
export type StripeCheckoutSessionStatus = z.infer<typeof stripeCheckoutSessionStatusSchema>;

export const stripePaymentStatusSchema = z.enum(["paid", "unpaid", "no_payment_required"]);
export type StripePaymentStatus = z.infer<typeof stripePaymentStatusSchema>;

export const stripeCheckoutSessionSchema = z.object({
  id: z.string(), // cs_xxx
  status: stripeCheckoutSessionStatusSchema.nullable().optional(),
  payment_status: stripePaymentStatusSchema.nullable().optional(),
  // Subscription mode was removed in the post-Slice-8 cleanup; the schema
  // still accepts the wider Stripe set so we recognize and ignore stray
  // events from accounts that ran subscriptions historically.
  mode: z.enum(["payment", "subscription", "setup"]),
  url: z.string().url().nullable().optional(),
  // Set instead of `url` when the session was created with
  // `ui_mode: "embedded"` — passed to @stripe/react-stripe-js's
  // EmbeddedCheckoutProvider on the client to mount the Payment Element
  // inline rather than redirecting to a Stripe-hosted page.
  client_secret: z.string().nullable().optional(),
  // We thread our internal idempotency UUID through `client_reference_id`
  // (set on the session create call) — easier to read than rummaging
  // through metadata when the webhook arrives.
  client_reference_id: z.string().nullable().optional(),
  // Payment Intent id — set once the session resolves on `mode=payment`.
  payment_intent: z.string().nullable().optional(),
  customer: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  amount_total: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  // Buyer identity Stripe resolves on the hosted page. `address` is present
  // once `billing_address_collection` is set and the session completes — the
  // capture source for VAT/GST readiness (persisted onto the Payment row).
  customer_details: z
    .object({
      address: stripeAddressSchema.nullable().optional(),
      email: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type StripeCheckoutSession = z.infer<typeof stripeCheckoutSessionSchema>;

// ---------------- PaymentIntent ----------------

// Stripe's PI status set is large; we only branch on a few. Anything else
// is treated as "not yet terminal".
export const stripePaymentIntentStatusSchema = z.enum([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
  "requires_capture",
  "canceled",
  "succeeded",
]);
export type StripePaymentIntentStatus = z.infer<typeof stripePaymentIntentStatusSchema>;

export const stripePaymentIntentSchema = z.object({
  id: z.string(), // pi_xxx
  status: stripePaymentIntentStatusSchema,
  amount: z.number(),
  amount_received: z.number().optional(),
  currency: z.string(),
  // Present on creation — handed to the mobile Stripe SDK's PaymentSheet
  // (initPaymentSheet) so the native UI can confirm this specific PI. Never
  // present on later retrieves without an explicit expand.
  client_secret: z.string().nullable().optional(),
  payment_method_types: z.array(z.string()).optional(),
  // The actual rail used (set after the buyer pays). `card` is the only
  // value we recognize; anything else collapses to `unknown`.
  payment_method: z.string().nullable().optional(),
  charges: z
    .object({
      data: z.array(
        z.object({
          id: z.string(),
          payment_method_details: z.object({ type: z.string().optional() }).partial().optional(),
        }),
      ),
    })
    .optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  latest_charge: z.string().nullable().optional(),
});
export type StripePaymentIntent = z.infer<typeof stripePaymentIntentSchema>;

// ---------------- Refund ----------------

export const stripeRefundSchema = z.object({
  id: z.string(), // re_xxx
  status: z.string(), // succeeded | pending | failed | canceled
  amount: z.number().optional(),
  payment_intent: z.string().nullable().optional(),
  charge: z.string().nullable().optional(),
});
export type StripeRefund = z.infer<typeof stripeRefundSchema>;

// PaymentIntent fetched with `expand[]=latest_charge.balance_transaction`.
// `balance_transaction.net` is the exact amount left after Stripe's fee +
// IVA — what we forward to the teacher so the platform nets $0. Both
// `latest_charge` and `balance_transaction` may still be a bare id (string)
// if the charge hasn't settled yet, in which case the net is unknown.
const stripeBalanceTransactionSchema = z.object({
  id: z.string(),
  net: z.number(),
  fee: z.number().optional(),
  currency: z.string(),
});
export const stripeSettledPaymentIntentSchema = z.object({
  id: z.string(),
  currency: z.string(),
  latest_charge: z
    .union([
      z.string(),
      z.object({
        id: z.string(),
        currency: z.string(),
        balance_transaction: z
          .union([z.string(), stripeBalanceTransactionSchema])
          .nullable()
          .optional(),
      }),
    ])
    .nullable()
    .optional(),
});
export type StripeSettledPaymentIntent = z.infer<typeof stripeSettledPaymentIntentSchema>;

// Resolved exact net for a settled charge, or null if not yet available.
// `feeMinorUnits` is the platform's Stripe processing cost on the charge (read
// from the balance transaction); used as the subscription-invoice fee so the
// persisted net = amount − fee is exact.
export type SettledCharge = {
  chargeId: string;
  netMinorUnits: number;
  // Optional so existing seeds (which predate billing) still type-check; the
  // real client always populates it from the balance transaction.
  feeMinorUnits?: number;
  currency: string;
};

// ---------------- Stripe Billing (platform-account subscriptions) ----------------
//
// These objects power the TEACHER's own subscription, billed on the platform
// (Mexican) Stripe account with the platform secret key only — NO Stripe-Account
// header, no Connect, no transfers. See docs/features/subscriptions.md.

export const stripeCustomerSchema = z.object({
  id: z.string(), // cus_xxx
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  // Set when the subscription Checkout wrote the collected billing address back
  // onto the Customer (`customer_update[address]=auto`). The capture source for
  // the teacher subscription rail's VAT/GST readiness fields.
  address: stripeAddressSchema.nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
});
export type StripeCustomer = z.infer<typeof stripeCustomerSchema>;

// Stripe subscription status set. We map these onto our own
// SubscriptionStatus in the billing webhook handler.
export const stripeSubscriptionStatusSchema = z.enum([
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
]);
export type StripeSubscriptionStatus = z.infer<typeof stripeSubscriptionStatusSchema>;

export const stripeSubscriptionSchema = z.object({
  id: z.string(), // sub_xxx
  // Exactly one of these identifies who is billed. Since D-143 the teacher's
  // own v2 `Account` is the billing customer, so a subscription created now
  // carries `customer_account: acct_…` and `customer` is null. A subscriber
  // from before the cutover still carries `customer: cus_…`. Both are nullable
  // for that reason — asserting either would reject half the population.
  customer: z.string().nullable().optional(), // cus_xxx (legacy)
  customer_account: z.string().nullable().optional(), // acct_xxx
  status: stripeSubscriptionStatusSchema,
  // ISO-4217, lowercase from the real API (e.g. "gbp"). Stripe always sets
  // this on a live subscription — it's the authoritative source for what a
  // SPECIFIC subscriber is actually billed in, deliberately never re-derived
  // from our own platform-region config (see billing-webhook-handler.ts).
  currency: z.string(),
  // Unix seconds.
  current_period_end: z.number().nullable().optional(),
  cancel_at_period_end: z.boolean().optional(),
  canceled_at: z.number().nullable().optional(),
  trial_end: z.number().nullable().optional(),
  items: z
    .object({
      data: z.array(
        z.object({
          price: z.object({ id: z.string() }).optional(),
        }),
      ),
    })
    .optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
});
export type StripeSubscription = z.infer<typeof stripeSubscriptionSchema>;

export const stripeInvoiceStatusSchema = z.enum(["draft", "open", "paid", "void", "uncollectible"]);
export type StripeInvoiceStatus = z.infer<typeof stripeInvoiceStatusSchema>;

export const stripeInvoiceSchema = z.object({
  id: z.string(), // in_xxx
  // See stripeSubscriptionSchema — `customer_account` since D-143, `customer`
  // for a legacy subscriber.
  customer: z.string().nullable().optional(),
  customer_account: z.string().nullable().optional(),
  subscription: z.string().nullable().optional(),
  status: stripeInvoiceStatusSchema.nullable().optional(),
  // Minor units.
  total: z.number().optional(),
  amount_paid: z.number().optional(),
  amount_due: z.number().optional(),
  // ISO-4217, lowercase from Stripe (e.g. "mxn"). The invoice's settlement
  // currency — recorded on the SubscriptionInvoice row for provenance.
  currency: z.string().optional(),
  // Unix seconds.
  period_start: z.number().nullable().optional(),
  period_end: z.number().nullable().optional(),
  charge: z.string().nullable().optional(),
  payment_intent: z.string().nullable().optional(),
});
export type StripeInvoice = z.infer<typeof stripeInvoiceSchema>;

export const stripeBillingPortalSessionSchema = z.object({
  id: z.string(),
  url: z.string().url(),
});
export type StripeBillingPortalSession = z.infer<typeof stripeBillingPortalSessionSchema>;

// ---------------- Dispute ----------------

// docs/security.md. The dispute lifecycle Stripe surfaces:
//   * issuer warning  → no money has moved; we have visibility but no
//     action required.
//   * needs_response  → cardholder has filed; Stripe will side with them
//     unless we submit evidence by `evidence_details.due_by`.
//   * under_review    → evidence submitted; Stripe is adjudicating.
//   * charge_refunded → we accepted the dispute.
//   * won / lost      → final.
export const stripeDisputeStatusSchema = z.enum([
  "warning_needs_response",
  "warning_under_review",
  "warning_closed",
  "needs_response",
  "under_review",
  "charge_refunded",
  "won",
  "lost",
]);
export type StripeDisputeStatus = z.infer<typeof stripeDisputeStatusSchema>;

export const stripeDisputeSchema = z.object({
  id: z.string(), // dp_xxx
  charge: z.string(),
  payment_intent: z.string().nullable().optional(),
  amount: z.number(),
  currency: z.string(),
  reason: z.string(),
  status: stripeDisputeStatusSchema,
  is_charge_refundable: z.boolean().optional(),
  evidence_details: z
    .object({
      due_by: z.number().nullable().optional(),
    })
    .partial()
    .optional(),
});
export type StripeDispute = z.infer<typeof stripeDisputeSchema>;

// `charge.refunded` payload. We only need the linked PaymentIntent and
// the refund flags; validating the shape (rather than an unchecked cast)
// keeps the handler honest if Stripe's payload drifts or a malformed —
// but signature-valid — event arrives.
export const stripeChargeSchema = z.object({
  id: z.string().optional(), // ch_xxx
  payment_intent: z.string().nullable().optional(),
  currency: z.string().optional(),
  refunded: z.boolean().optional(),
  amount_refunded: z.number().optional(),
});
export type StripeCharge = z.infer<typeof stripeChargeSchema>;

// ---------------- Webhook envelope ----------------

// Stripe's webhook body is `{ id, type, data: { object: <resource> } }`.
// We accept the raw shape; the handler re-parses `data.object` against the
// resource-specific schema based on `type`.
export const stripeWebhookEnvelopeSchema = z.object({
  id: z.string(),
  type: z.string(),
  livemode: z.boolean().optional(),
  data: z.object({
    object: z.unknown(),
  }),
  // Connect events carry `account: 'acct_xxx'`. Platform-level events
  // (account.updated, charge.refunded on the platform's connected
  // accounts) omit it.
  account: z.string().optional(),
});
export type StripeWebhookEnvelope = z.infer<typeof stripeWebhookEnvelopeSchema>;

// ---------------- Rail normalization ----------------

import type { PaymentRail } from "@prisma/client";

// Map Stripe's `payment_method_details.type` (or `payment_method` string)
// onto our PaymentRail enum. Anything we don't recognize collapses to
// `unknown`.
export function normalizeRail(stripeMethodType: string | undefined | null): PaymentRail {
  switch (stripeMethodType) {
    case "card":
      return "card";
    default:
      return "unknown";
  }
}
