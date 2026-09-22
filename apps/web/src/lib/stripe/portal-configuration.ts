import type Stripe from "stripe";

// The Customer Portal, declared in code instead of left to Stripe's defaults.
//
// WHY THIS FILE EXISTS. Passing no `configuration` when creating a portal
// session means Stripe uses the account's default one — which it creates
// lazily, on the first session anyone opens, from ITS defaults. So the portal
// that a teacher uses to change her card or cancel was defined by nothing in
// this repository: not reviewed, not diffable, not tested, and changeable by
// any click in the Stripe Dashboard. The product's own buttons ("Manage
// billing", "Update payment method", "Resume subscription") all lead there, so
// what they actually DO was configuration nobody owned.
//
// This module is the declaration. `scripts/stripe/sync-portal-configuration.ts`
// applies it and prints the id to pin in STRIPE_BILLING_PORTAL_CONFIG_ID.
//
// ── The founding-price trap ───────────────────────────────────────────────
//
// All three plans are prices on ONE Stripe product. Enabling plan switching by
// naming that product would let any subscriber switch herself onto the £5.99
// founding price from the portal — bypassing `getFoundingCohortState` entirely,
// past the cohort cap, past the cutoff date, forever, because founding is
// price-locked for the life of the subscription. Stripe's portal has no notion
// of our cohort rules and cannot be taught one.
//
// So the switchable set is monthly and annual, named individually. Founding is
// reachable only through checkout, which is where the cohort gate lives. This
// is enforced by construction — the builder below has no parameter for it — and
// pinned by a test, because a later "just pass the product id" refactor is
// exactly how it would come back.

export type PortalPlanPrices = {
  /** The Stripe product all plan prices hang off. */
  productId: string;
  /** The two prices a subscriber may move between. NOT founding — see above. */
  monthlyPriceId: string;
  annualPriceId: string;
};

export type PortalConfigurationContext = PortalPlanPrices & {
  /** Origin used to build the policy links shown inside the portal. */
  appUrl: string;
};

/**
 * The desired portal configuration, as create/update params.
 *
 * Pure: takes ids and returns an object, so the whole shape is unit-testable
 * without touching Stripe.
 */
export function buildPortalConfigurationParams(
  ctx: PortalConfigurationContext,
): Stripe.BillingPortal.ConfigurationCreateParams {
  const appUrl = ctx.appUrl.replace(/\/$/, "");
  return {
    business_profile: {
      // Stripe renders these inside the portal. Left null by the lazy default,
      // which is a policy gap on a page where money changes hands.
      privacy_policy_url: `${appUrl}/privacy`,
      terms_of_service_url: `${appUrl}/terms`,
    },
    features: {
      // She can correct her own billing details. `tax_id` is deliberately not
      // offered: nothing computes tax yet (see lib/stripe/tax.ts), so a VAT
      // number collected here would sit unused and imply otherwise.
      customer_update: {
        enabled: true,
        allowed_updates: ["address", "email", "name"],
      },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      // Matches the documented policy exactly: cancel takes effect at the end
      // of the period already paid for, and no proration is given. This is also
      // what produces `cancel_at_period_end`, which the billing webhook now
      // records and the settings page reads to say "Ends" rather than "Renews".
      subscription_cancel: {
        enabled: true,
        mode: "at_period_end",
        proration_behavior: "none",
      },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        // Monthly and annual only. See the founding-price trap above.
        products: [
          {
            product: ctx.productId,
            prices: [ctx.monthlyPriceId, ctx.annualPriceId],
          },
        ],
        // Upgrading mid-cycle credits the unused time against the new charge
        // rather than silently discarding it.
        proration_behavior: "create_prorations",
        // ...but a DOWNGRADE waits for the period she has already paid for.
        // Applying it immediately would take away the Pro she is paid up for
        // and hand back a balance credit she did not ask for.
        schedule_at_period_end: {
          conditions: [{ type: "decreasing_item_amount" }],
        },
      },
    },
  };
}

/** The update shape is the same minus nothing — Stripe accepts both. */
export function buildPortalConfigurationUpdateParams(
  ctx: PortalConfigurationContext,
): Stripe.BillingPortal.ConfigurationUpdateParams {
  return buildPortalConfigurationParams(ctx) as Stripe.BillingPortal.ConfigurationUpdateParams;
}
