import Stripe from "stripe";
import { bankTransferTypeFor, localPaymentCapabilitiesFor } from "@spiralclass/shared";
import {
  stripeAccountLinkSchema,
  stripeAccountSchema,
  stripeV2AccountSchema,
  stripeAccountSessionSchema,
  stripeChargeSchema,
  stripeCheckoutSessionSchema,
  stripePaymentIntentSchema,
  stripeRefundSchema,
  stripeSettledPaymentIntentSchema,
  stripeBillingPortalSessionSchema,
  stripeCustomerSchema,
  stripeInvoiceSchema,
  stripeSubscriptionSchema,
  type SettledCharge,
  type StripeAccount,
  type StripeAccountLink,
  type StripeAccountSession,
  type StripeBillingPortalSession,
  type StripeCharge,
  type StripeCheckoutSession,
  type StripeCustomer,
  type StripeInvoice,
  type StripePaymentIntent,
  type StripeRefund,
  type StripeSubscription,
} from "./types";

// Thin interface around the Stripe API. One real implementation
// (`fetchStripeClient`, backed by the official `stripe` SDK) and one
// in-memory stub (`stub.ts`) used in tests and when STRIPE_SECRET_KEY is
// absent in dev. Every method is async so callers await uniformly
// regardless of backend.
//
// We only use the platform's secret key. Since D-143 the TEACHER is the
// merchant of record: a lesson charge is a DIRECT charge created on her
// connected account via the `Stripe-Account` header, so the PaymentIntent,
// the charge and the settled funds all live on HER account and Stripe pays her
// out locally. The platform balance is only ever touched by the platform's own
// subscription billing, which is a plain platform charge with no Connect
// involvement at all. There is no Transfer anywhere in this file — do not
// reintroduce one.

export type CreateConnectedAccountInput = {
  email: string;
  // ISO-3166-1 alpha-2. Stripe fixes a connected account's country at creation
  // and never lets it change, and it decides which local payment methods she
  // can offer her students — a Mexican account can present OXXO and SPEI, a
  // Brazilian one Pix. Must be a member of SUPPORTED_CONNECT_COUNTRIES; callers
  // gate on isConnectCountrySupported() before reaching here.
  country: string;
  // Her settlement currency. Also fixed at creation, and normally her own
  // pricing currency. Note BG must be created with EUR — Stripe now refuses BGN.
  currency: string;
  // The teacher's name on the connected account — surfaces in Stripe's
  // hosted onboarding UI.
  businessName?: string;
  // STABLE per teacher, and load-bearing. Creating a connected account is a
  // check-then-create against our own DB, so concurrent callers — Connect.js
  // re-invoking fetchClientSecret, a remount, a double-submit — can all read a
  // null stripeAccountId and each mint an account. Every other money call in
  // this client already passes a stable key (`cs-…`, `refund-…`); this one used
  // a random UUID, and on 2026-08-30 that produced FOURTEEN live connected
  // accounts for one teacher in two bursts. With a stable key Stripe collapses
  // the duplicates and returns the same account to every caller.
  idempotencyKey?: string;
};

// A billing-only Account: the teacher as our CUSTOMER, with no merchant
// configuration and therefore no ability to take card payments.
//
// This exists because the two things are independent. Stripe refuses a
// `merchant` configuration in some countries (IN, ZA, NG, ID, IS) — but a
// teacher there still buys the software, and a `customer`-only Account is
// accepted for exactly those countries. Verified against test mode for ZA on
// 2026-08-30, which is one of the merchant refusals.
export type CreateCustomerAccountInput = {
  email: string;
  country: string;
  businessName?: string;
};

export type CreateAccountLinkInput = {
  accountId: string;
  returnUrl: string;
  refreshUrl: string;
  // 'account_onboarding' for first-time KYC; 'account_update' for
  // re-collection prompts (e.g. when Stripe asks for additional docs).
  type: "account_onboarding" | "account_update";
};

export type CreateAccountSessionInput = {
  accountId: string;
  // Which embedded components this session authorizes. Onboarding covers
  // both first-time KYC and re-verification prompts (Stripe reuses the same
  // component for both, unlike Account Links' two `type`s).
  components?: {
    accountOnboarding?: boolean;
  };
};

// Fixed-package one-time charge, as a DIRECT charge on the teacher's account.
//
// This block described separate charges and transfers until 2026-08-31 — "a
// PLAIN platform charge (no transfer_data)", funds landing on the platform, a
// `transfer-on-paid` Inngest job forwarding the net. D-143 deleted all of it:
// there is no Transfer, no `transfer-on-paid` job, and the platform balance is
// never involved in a lesson payment. The charge is created on her account with
// the `Stripe-Account` header, settles in her country, and a refund or
// chargeback debits her rather than us.
//
// Nor is it card-only any more. `payment_method_types` is deliberately omitted
// so Stripe offers what her students can actually use — measured live on
// 2026-08-31, a Mexican teacher's checkout returns ["card", "oxxo", "link"].
export type CreateCheckoutSessionInput = {
  // The TEACHER's connected account. The session is created ON her account
  // (`Stripe-Account`), making this a DIRECT charge: the PaymentIntent, the
  // charge and the settled funds are hers, and Stripe pays her out locally.
  // Required — a lesson charge on the platform account would make the platform
  // merchant of record again, which is the thing D-143 removed.
  connectedAccountId: string;
  // Our payment row's external_reference UUID; threaded through Stripe so
  // the webhook can resolve the row idempotently.
  clientReferenceId: string;
  // Hosted mode (default): the student is redirected to a Stripe-hosted
  // page; successUrl/cancelUrl are required. Embedded mode (Payment
  // Element inline, no redirect): pass `returnUrl` instead — Stripe
  // substitutes `{CHECKOUT_SESSION_ID}` in it once the session resolves.
  // The two url shapes are mutually exclusive per Stripe's Checkout API.
  uiMode?: "hosted" | "embedded";
  successUrl?: string;
  cancelUrl?: string;
  returnUrl?: string;
  customerEmail: string;
  // A Customer on HER account, from `ensureCheckoutCustomer`. Optional, and
  // mutually exclusive with `customerEmail` — Stripe rejects a session carrying
  // both, so passing this replaces the email rather than supplementing it.
  //
  // Only needed to offer bank transfer (SPEI): `customer_balance` funds a
  // customer's cash balance, so Stripe refuses the session without one, and
  // `customer_creation: "always"` does not count (measured — see
  // stripe-capabilities.ts). Every other method works fine on the email alone.
  customerId?: string;
  // Her country, used ONLY to pick the bank-transfer variant
  // (`mx_bank_transfer` for Mexico). Omit it and the session simply doesn't
  // offer bank transfer, which is the right failure: a wrong variant is
  // rejected outright, so guessing is worse than not asking.
  merchantCountry?: string;
  // Inline price (no Stripe Product/Price catalog needed for one-off charges).
  lineItem: {
    name: string;
    description?: string;
    amountMinorUnits: number;
    // Lowercase ISO-4217 charge currency. "mxn" for every charge today, but
    // typed as string so it carries the row's settlement currency.
    currency: string;
  };
  // Free-form k/v echoed back on the PaymentIntent. We stash teacherId
  // + packageId so the webhook can disambiguate.
  metadata?: Record<string, string>;
  // VAT/GST readiness (global-launch item 7). `billingAddressCollection`
  // defaults to "required" so the hosted page always collects a billing
  // address we can persist (capture-now). `automaticTax` toggles Stripe's tax
  // computation and is OFF unless the caller passes stripeTaxEnabled() — never
  // collected/remitted without an explicit business decision.
  billingAddressCollection?: "auto" | "required";
  automaticTax?: boolean;
};

export type EnsureCheckoutCustomerInput = {
  // The TEACHER's account. The Customer belongs to her, not the platform —
  // she is the merchant, and these are her buyers.
  connectedAccountId: string;
  email: string;
  name?: string;
};

// Raw PaymentIntent (no Checkout Session) — the mobile native flow.
// Stripe's mobile SDKs (PaymentSheet) confirm a PaymentIntent directly; they
// have no concept of a Checkout Session (hosted or embedded), which is a
// web-only construct. Same plain-platform-charge shape as the one-off
// Checkout Session (separate charges & transfers, card-only): no
// transfer_data, the teacher is paid via a separate Transfer once the charge
// settles.
export type CreatePaymentIntentInput = {
  amountMinorUnits: number;
  currency: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
};

export type CreateRefundInput = {
  // Either pass payment_intent (preferred for one-time charges) or a
  // specific charge id (legacy). We always have the PI.
  paymentIntentId: string;
  reason?: "duplicate" | "fraudulent" | "requested_by_customer";
  // The TEACHER's connected account — the charge is hers (D-143), so the
  // refund must be created as her or Stripe cannot find the PaymentIntent.
  // Refunding debits HER balance, which is why no clawback follows.
  connectedAccountId?: string;
};

// ----- Stripe Billing (platform-account subscriptions) -----
// The teacher's OWN subscription. Platform secret key only — no Stripe-Account
// header, no Connect. See docs/features/subscriptions.md.

export type CreateBillingCustomerInput = {
  email: string;
  name?: string;
  // We stash teacher_id so webhook events resolve our row from the customer.
  metadata?: Record<string, string>;
};

export type CreateBillingCheckoutSessionInput = {
  // The teacher's own v2 `Account`, acting as the billing customer (D-143).
  // Her Account carries the `customer` configuration alongside `merchant`, so
  // ONE object both takes her students' payments and gets billed by us — there
  // is no separate `Customer` object and no Account-to-Customer mapping table.
  // Preferred over customerId/customerEmail for every new subscription.
  customerAccountId?: string;
  // Legacy: an existing platform `Customer`, or customerEmail to let Stripe
  // create one during checkout. Retained for a v1-era subscriber; new
  // checkouts pass customerAccountId.
  customerId?: string;
  customerEmail?: string;
  // The Stripe Price id (from env) for the chosen plan.
  priceId: string;
  clientReferenceId: string;
  // See CreateCheckoutSessionInput — same hosted-vs-embedded shape.
  uiMode?: "hosted" | "embedded";
  successUrl?: string;
  cancelUrl?: string;
  returnUrl?: string;
  // Days of free trial to grant on the subscription (no card charged until it
  // ends). Omit for an immediate charge.
  trialPeriodDays?: number;
  metadata?: Record<string, string>;
  // VAT/GST readiness (global-launch item 7). Same capture-now, enable-later
  // shape as the one-off checkout: `billingAddressCollection` defaults to
  // "required"; when a `customerId` is set the collected address is also written
  // back onto the Customer (see createBillingCheckoutSession). `automaticTax` is
  // OFF unless the caller passes stripeTaxEnabled().
  billingAddressCollection?: "auto" | "required";
  automaticTax?: boolean;
  // Shows a promo-code entry field on the hosted Checkout page. Codes
  // themselves are created/enabled in the Stripe Dashboard (Coupons +
  // Promotion Codes) — this only opts the session into showing the field.
  allowPromotionCodes?: boolean;
};

export type CreateBillingPortalSessionInput = {
  // The teacher's own v2 `Account`, acting as the billing customer (D-143).
  // Preferred; `customerId` is the legacy Customer path, kept for a subscriber
  // created before the cutover.
  customerAccountId?: string;
  customerId?: string;
  returnUrl: string;
  // The portal configuration to open against (see lib/stripe/portal-configuration.ts).
  // Omitted, Stripe falls back to the account default it creates lazily from
  // its OWN defaults — which is how the portal's behaviour ended up defined by
  // nothing in this repo. Optional so an environment that has not run the sync
  // script yet still opens a working portal rather than erroring.
  configurationId?: string;
};

export interface StripeClient {
  // ----- Connect -----
  createConnectedAccount(input: CreateConnectedAccountInput): Promise<StripeAccount>;
  // Billing-only counterpart, for a teacher whose country Stripe will not
  // accept as a merchant. Returns the v2 Account id — there is no v1 shape to
  // hand back, because an account with no merchant configuration has no
  // charges_enabled/payouts_enabled to speak of.
  createCustomerAccount(input: CreateCustomerAccountInput): Promise<{ id: string }>;
  getConnectedAccount(accountId: string): Promise<StripeAccount>;
  createAccountLink(input: CreateAccountLinkInput): Promise<StripeAccountLink>;
  createAccountSession(input: CreateAccountSessionInput): Promise<StripeAccountSession>;

  // ----- Checkout / payments -----
  // Every read below takes the TEACHER's connected account id, because since
  // D-143 the session, the PaymentIntent and the charge live on HER account —
  // a platform-scoped retrieve 404s. It is optional only so the platform's own
  // subscription billing, which really is a platform charge, can omit it.
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<StripeCheckoutSession>;
  // Find-or-create a Customer on the TEACHER's connected account for this
  // student's email. Only bank transfer needs it (see CreateCheckoutSessionInput
  // .customerId); everything else is happy with `customer_email`.
  ensureCheckoutCustomer(input: EnsureCheckoutCustomerInput): Promise<string>;
  getCheckoutSession(
    sessionId: string,
    connectedAccountId?: string,
  ): Promise<StripeCheckoutSession>;
  expireCheckoutSession(
    sessionId: string,
    connectedAccountId?: string,
  ): Promise<StripeCheckoutSession>;
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<StripePaymentIntent>;
  getPaymentIntent(
    paymentIntentId: string,
    connectedAccountId?: string,
  ): Promise<StripePaymentIntent>;

  // ----- Refunds -----
  createRefund(input: CreateRefundInput): Promise<StripeRefund>;

  // ----- Settled charge reads -----
  // Read the settled charge's exact net (after fee), or null if it hasn't
  // settled yet. Retained for the PLATFORM's own subscription billing
  // (billing-webhook-handler). The teacher payout that used to read this died
  // with separate charges and transfers (D-143): under direct charges the
  // money settles on her account and never passes through ours.
  getSettledCharge(
    paymentIntentId: string,
    connectedAccountId?: string,
  ): Promise<SettledCharge | null>;
  // Read-only retrieve used by the /admin/uat Stripe check (D-55) to confirm
  // charge state directly against Stripe, independent of what our own
  // DB/webhook handling recorded.
  getCharge(chargeId: string, connectedAccountId?: string): Promise<StripeCharge>;

  // ----- Billing (platform-account subscriptions) -----
  createBillingCustomer(input: CreateBillingCustomerInput): Promise<StripeCustomer>;
  getBillingCustomer(customerId: string): Promise<StripeCustomer>;
  createBillingCheckoutSession(
    input: CreateBillingCheckoutSessionInput,
  ): Promise<StripeCheckoutSession>;
  getSubscription(subscriptionId: string): Promise<StripeSubscription>;
  cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<StripeSubscription>;
  createBillingPortalSession(
    input: CreateBillingPortalSessionInput,
  ): Promise<StripeBillingPortalSession>;
  getInvoice(invoiceId: string): Promise<StripeInvoice>;
}

// Deliberately pinned to the account's current API version rather than the
// SDK's bundled latest (`Stripe.ApiVersion`, "2026-06-24.dahlia" as of the
// stripe@22 migration) — bumping the account API version is a separate,
// consequential decision: Stripe's object/event shapes can rename or
// restructure fields across versions, which would need its own changelog
// review against every schema in ./types.ts, not something to bundle
// silently into an SDK-client swap.
// The version bundled with the pinned `stripe` SDK (22.3.2). Moved here from
// "2024-06-20" at D-143: the Accounts v2 endpoints the connected-account
// creation below needs are not reachable on the old pin.
//
// This is Stripe's STABLE version, not a preview. Accounts v2 documentation
// shows "2026-08-26.preview", and an early draft of D-143 accepted a preview
// API as a cost of the migration — but the identical account creates cleanly
// on this one, verified against test mode. Do not reintroduce a `.preview` pin
// without a reason that survives a probe.
export const STRIPE_API_VERSION = "2026-06-24.dahlia" as Stripe.StripeConfig["apiVersion"];

// Matches the SDK's own defaults: up to 2 retries on transient failure,
// exponential backoff with jitter, handled internally by the SDK.
const DEFAULT_MAX_RETRIES = 2;

export function fetchStripeClient(deps: {
  secretKey: string;
  // Test seam: inject a fake `fetch` so tests control responses without a
  // real network call. Passed straight through to the SDK's fetch-based
  // HTTP client (`Stripe.createFetchHttpClient`).
  fetchImpl?: typeof fetch;
  // `maxRetries` of 0 disables the SDK's automatic retries entirely (used
  // by tests that want to assert a single failed call).
  maxRetries?: number;
  randomUUID?: () => string;
}): StripeClient {
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
  const maxNetworkRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;

  const stripe = new Stripe(deps.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries,
    httpClient: Stripe.createFetchHttpClient(deps.fetchImpl ?? fetch),
  });

  // Every mutating (POST-shaped) SDK call gets an explicit idempotency key —
  // synthesized per call unless the caller passed a stable one — so a
  // retried request (ours or the SDK's own) is collapsed by Stripe instead
  // of creating a duplicate account / refund / checkout session / transfer.
  function idem(explicitKey?: string): Stripe.RequestOptions {
    return { idempotencyKey: explicitKey ?? randomUUID() };
  }

  // Scopes a request to a connected account (the `Stripe-Account` header).
  // Since D-143 a lesson's session, PaymentIntent, charge and refund all live
  // on the TEACHER's account, so reading or refunding one without this 404s.
  // Returns an empty object when no id is given, which is correct for the
  // platform's own subscription billing — that genuinely is a platform charge.
  function onAccount(connectedAccountId?: string): Stripe.RequestOptions {
    return connectedAccountId ? { stripeAccount: connectedAccountId } : {};
  }

  // Wraps every SDK call: translates thrown Stripe errors into our own
  // StripeApiError (so `isStripeConnectNotEnabledError` and callers written
  // against the old REST client keep working unchanged), and validates the
  // response against our own Zod schema as a defense-in-depth check on top
  // of the SDK's typing.
  async function call<T>(
    path: string,
    fn: () => Promise<unknown>,
    schema: { parse: (data: unknown) => T },
  ): Promise<T> {
    try {
      const result = await fn();
      return schema.parse(result);
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError) {
        const status = err.statusCode ?? 0;
        const body = JSON.stringify(err.raw ?? { message: err.message });
        throw new StripeApiError(status, body, path);
      }
      throw err;
    }
  }

  // Reads a connected account in the v1 shape. Shared by the public
  // `getConnectedAccount` and by `createConnectedAccount`, which creates via v2
  // and then hands back the v1 shape its callers expect. A plain function
  // rather than `this.getConnectedAccount` — callers destructure this client,
  // and `this` would be undefined the moment one did.
  async function getConnectedAccount(accountId: string): Promise<StripeAccount> {
    return call("/v1/accounts", () => stripe.accounts.retrieve(accountId), stripeAccountSchema);
  }

  return {
    // Accounts v2 (D-143). The legacy `type: "express"` account this replaced
    // could not take direct charges at all — Stripe's own guidance is that a
    // full-dashboard account is the one that acts as merchant of record.
    //
    // Each field is load-bearing:
    //   dashboard "full"     — she gets a real Stripe account; Stripe owns her
    //                          verification, compliance updates and support.
    //   merchant             — she accepts payments as MERCHANT OF RECORD. This
    //                          is the configuration direct charges require; the
    //                          `recipient` configuration is the separate-charges
    //                          -and-transfers one and must NOT be requested.
    //   customer             — lets the platform bill her for the subscription
    //                          against this same object, so there is no Account
    //                          -to-Customer mapping table to maintain.
    //   fees_collector       — "stripe": Stripe bills HER for card processing at
    //                          her own country's rates, which are usually better
    //                          for her than a UK cross-border rate.
    //   losses_collector     — "stripe": a chargeback debits HER balance. This is
    //                          what keeps the platform out of client-money
    //                          territory entirely.
    //
    // The account is created RESTRICTED (`requirements_past_due`) and cannot
    // charge until she completes onboarding — that is expected, not an error.
    //
    // Reads still go through the v1 endpoint: Stripe returns a v2 account in the
    // v1 shape, so `getConnectedAccount`, the `account.updated` webhook and the
    // charges_enabled/payouts_enabled columns are all unchanged by this.
    async createConnectedAccount(input) {
      const account = await call(
        "/v2/core/accounts",
        () =>
          stripe.v2.core.accounts.create(
            {
              contact_email: input.email,
              ...(input.businessName ? { display_name: input.businessName } : {}),
              dashboard: "full",
              identity: { country: input.country.toLowerCase() },
              configuration: {
                merchant: {
                  capabilities: {
                    card_payments: { requested: true },
                    // Her country's local methods — OXXO and SPEI for a Mexican
                    // teacher, Boleto for a Brazilian one. Requested at CREATION
                    // because a capability not asked for here is simply never
                    // offered, however well the rest of the integration works:
                    // the account onboards clean, the checkout renders, and the
                    // student is quietly shown cards only.
                    //
                    // A name v2 does not know 400s this whole call, so the
                    // registry is measured rather than written from the v1
                    // vocabulary — see stripe-capabilities.ts and
                    // scripts/probe-v2-capabilities.mjs.
                    ...Object.fromEntries(
                      localPaymentCapabilitiesFor(input.country).map((cap) => [
                        cap,
                        { requested: true },
                      ]),
                    ),
                  },
                },
                customer: {},
              },
              defaults: {
                currency: input.currency.toLowerCase(),
                responsibilities: {
                  fees_collector: "stripe",
                  losses_collector: "stripe",
                },
              },
            },
            idem(input.idempotencyKey),
          ),
        stripeV2AccountSchema,
      );
      // Hand back the v1 shape every existing caller is written against.
      return await getConnectedAccount(account.id);
    },

    // Customer configuration only — she is billable, not a merchant. Deliberately
    // NOT a flag on createConnectedAccount: the two have different failure modes
    // (a merchant account can be refused by country; this one is not) and
    // different consequences, and a boolean would hide that at the call site.
    async createCustomerAccount(input) {
      return await call(
        "/v2/core/accounts",
        () =>
          stripe.v2.core.accounts.create(
            {
              contact_email: input.email,
              ...(input.businessName ? { display_name: input.businessName } : {}),
              identity: { country: input.country.toLowerCase() },
              configuration: { customer: {} },
            },
            idem(),
          ),
        stripeV2AccountSchema,
      );
    },

    getConnectedAccount,

    async createAccountLink(input) {
      return call(
        "/v1/account_links",
        () =>
          stripe.accountLinks.create({
            account: input.accountId,
            return_url: input.returnUrl,
            refresh_url: input.refreshUrl,
            type: input.type,
          }),
        stripeAccountLinkSchema,
      );
    },

    async createAccountSession(input) {
      return call(
        "/v1/account_sessions",
        () =>
          stripe.accountSessions.create({
            account: input.accountId,
            components: {
              ...(input.components?.accountOnboarding !== false
                ? {
                    account_onboarding: {
                      enabled: true,
                      features: { external_account_collection: true },
                    },
                  }
                : {}),
            },
          }),
        stripeAccountSessionSchema,
      );
    },

    // Find-or-create rather than always-create: a returning student would
    // otherwise accumulate one Customer per purchase on the teacher's account,
    // splitting her own view of a buyer she thinks of as one person. Stripe has
    // no uniqueness constraint on customer email, so the search is ours to do.
    //
    // The lookup is scoped to HER account by the Stripe-Account header, so two
    // teachers with the same student never see each other's Customer.
    async ensureCheckoutCustomer(input) {
      const account = onAccount(input.connectedAccountId);
      const existing = await stripe.customers.list({ email: input.email, limit: 1 }, account);
      const found = existing.data[0];
      if (found) return found.id;

      const created = await stripe.customers.create(
        { email: input.email, ...(input.name ? { name: input.name } : {}) },
        account,
      );
      return created.id;
    },

    async createCheckoutSession(input) {
      // Embedded Checkout renders the Payment Element inline (no redirect)
      // — `return_url` replaces success_url/cancel_url and Stripe rejects
      // the request if both shapes are present. Hosted stays the default
      // so every existing caller is unaffected.
      const urlParams: Pick<
        Stripe.Checkout.SessionCreateParams,
        "ui_mode" | "return_url" | "success_url" | "cancel_url"
      > =
        input.uiMode === "embedded"
          ? {
              ui_mode: "embedded_page",
              ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
            }
          : {
              ...(input.successUrl ? { success_url: input.successUrl } : {}),
              ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
            };
      const bankTransfer = input.merchantCountry
        ? bankTransferTypeFor(input.merchantCountry)
        : null;
      return call(
        "/v1/checkout/sessions",
        () =>
          stripe.checkout.sessions.create(
            {
              mode: "payment",
              client_reference_id: input.clientReferenceId,
              // Exactly one of these — Stripe rejects a session carrying both.
              // The Customer wins when present because it is the only shape
              // that can offer bank transfer.
              ...(input.customerId
                ? { customer: input.customerId }
                : { customer_email: input.customerEmail }),
              // Bank transfer (SPEI in Mexico) is the one method dynamic
              // payment methods cannot switch on by itself: `customer_balance`
              // is rejected without a funding type and a country-specific
              // transfer variant, so those have to be stated even though every
              // other method is left to Stripe. Sent only when we have BOTH a
              // Customer and a known variant for her country — an unknown
              // country omits the option and simply offers no bank transfer,
              // rather than guessing a variant Stripe would reject.
              ...(input.customerId && bankTransfer
                ? {
                    payment_method_options: {
                      customer_balance: {
                        funding_type: "bank_transfer",
                        bank_transfer: {
                          type: bankTransfer as "mx_bank_transfer",
                        },
                      },
                    },
                  }
                : {}),
              // NO payment_method_types. Omitting it puts Checkout on dynamic
              // payment methods, so Stripe offers what the STUDENT can actually
              // use, ranked for conversion, from what is enabled on the
              // teacher's account.
              //
              // This is the conversion half of D-143 and it is only reachable
              // because the charge is hers: offerable methods are decided by the
              // MERCHANT's country, so a Mexican teacher's checkout can present
              // OXXO and SPEI, a Brazilian one Pix, a Dutch one iDEAL. A UK
              // platform charge could offer none of them at any price.
              //
              // This was `payment_method_types: ["card"]`, and the reason given
              // was that async methods confirm over hours and would leave the
              // package pending past the booking flow. That is a real UX cost
              // and still true — but it is not a broken flow: an async method's
              // `checkout.session.completed` arrives unpaid and the handler
              // no-ops on it deliberately, then the later
              // `payment_intent.succeeded` resolves the row through
              // `metadata.external_reference` and flips it paid. The student
              // waits for their class the same way the manual transfer rail
              // already makes them wait. Which methods a teacher offers is hers
              // to choose in her own dashboard.
              adaptive_pricing: { enabled: true },
              line_items: [
                {
                  quantity: 1,
                  price_data: {
                    currency: input.lineItem.currency,
                    unit_amount: input.lineItem.amountMinorUnits,
                    product_data: {
                      name: input.lineItem.name,
                      ...(input.lineItem.description
                        ? { description: input.lineItem.description }
                        : {}),
                    },
                  },
                },
              ],
              // VAT/GST readiness (global-launch item 7): always collect a
              // billing address on the hosted page so we can persist the
              // buyer's country + address (read back off `customer_details`
              // in the webhook). `automatic_tax` stays OFF unless the caller
              // flips stripeTaxEnabled().
              billing_address_collection: input.billingAddressCollection ?? "required",
              ...(input.automaticTax ? { automatic_tax: { enabled: true } } : {}),
              ...urlParams,
              // No transfer_data and no application_fee_amount. The money is
              // hers from the moment it settles; the platform takes nothing at
              // the charge (D-143) and has nothing to forward.
              //
              // Echo metadata to both the session and the resulting PI so
              // the webhook can resolve our row regardless of which event
              // fires first — and, on an async payment method, so the later
              // `payment_intent.succeeded` can resolve it with no session in
              // hand at all.
              metadata: input.metadata,
              payment_intent_data: input.metadata ? { metadata: input.metadata } : undefined,
            },
            { ...idem(`cs-${input.clientReferenceId}`), stripeAccount: input.connectedAccountId },
          ),
        stripeCheckoutSessionSchema,
      );
    },

    async getCheckoutSession(sessionId, connectedAccountId) {
      return call(
        "/v1/checkout/sessions",
        () =>
          stripe.checkout.sessions.retrieve(sessionId, undefined, onAccount(connectedAccountId)),
        stripeCheckoutSessionSchema,
      );
    },

    async expireCheckoutSession(sessionId, connectedAccountId) {
      // Idempotent on Stripe's side: expiring an already-expired/completed
      // session 400s, so the caller treats failures as best-effort.
      return call(
        "/v1/checkout/sessions",
        () => stripe.checkout.sessions.expire(sessionId, undefined, onAccount(connectedAccountId)),
        stripeCheckoutSessionSchema,
      );
    },

    async createPaymentIntent(input) {
      return call(
        "/v1/payment_intents",
        () =>
          stripe.paymentIntents.create(
            {
              amount: input.amountMinorUnits,
              currency: input.currency,
              payment_method_types: ["card"],
              ...(input.customerEmail ? { receipt_email: input.customerEmail } : {}),
              ...(input.metadata ? { metadata: input.metadata } : {}),
            },
            idem(input.idempotencyKey),
          ),
        stripePaymentIntentSchema,
      );
    },

    async getPaymentIntent(paymentIntentId, connectedAccountId) {
      return call(
        "/v1/payment_intents",
        () =>
          stripe.paymentIntents.retrieve(paymentIntentId, undefined, onAccount(connectedAccountId)),
        stripePaymentIntentSchema,
      );
    },

    // Refunds are created AS the connected account, because the charge is hers
    // (D-143). The money comes back out of her balance, which is also why there
    // is no clawback step any more.
    async createRefund(input) {
      return call(
        "/v1/refunds",
        () =>
          stripe.refunds.create(
            {
              payment_intent: input.paymentIntentId,
              ...(input.reason ? { reason: input.reason } : {}),
            },
            {
              ...idem(`refund-${input.paymentIntentId}`),
              ...onAccount(input.connectedAccountId),
            },
          ),
        stripeRefundSchema,
      );
    },

    async getSettledCharge(paymentIntentId, connectedAccountId) {
      const pi = await call(
        "/v1/payment_intents",
        () =>
          stripe.paymentIntents.retrieve(
            paymentIntentId,
            {
              expand: ["latest_charge.balance_transaction"],
            },
            onAccount(connectedAccountId),
          ),
        stripeSettledPaymentIntentSchema,
      );
      const charge = pi.latest_charge;
      // Bare id (string) or absent → charge not expanded / not settled.
      if (!charge || typeof charge === "string") return null;
      const bt = charge.balance_transaction;
      if (!bt || typeof bt === "string") return null;
      return {
        chargeId: charge.id,
        netMinorUnits: bt.net,
        feeMinorUnits: bt.fee ?? 0,
        currency: bt.currency,
      };
    },

    async getCharge(chargeId, connectedAccountId) {
      return call(
        "/v1/charges",
        () => stripe.charges.retrieve(chargeId, undefined, onAccount(connectedAccountId)),
        stripeChargeSchema,
      );
    },

    // ----- Billing -----

    async createBillingCustomer(input) {
      return call(
        "/v1/customers",
        () =>
          stripe.customers.create({
            email: input.email,
            ...(input.name ? { name: input.name } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {}),
          }),
        stripeCustomerSchema,
      );
    },

    async getBillingCustomer(customerId) {
      return call(
        "/v1/customers",
        () => stripe.customers.retrieve(customerId),
        stripeCustomerSchema,
      );
    },

    async createBillingCheckoutSession(input) {
      // mode=subscription — a recurring platform charge. No transfer_data, no
      // Stripe-Account header: this bills the teacher on the platform account.
      const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {};
      if (input.trialPeriodDays && input.trialPeriodDays > 0) {
        subscriptionData.trial_period_days = input.trialPeriodDays;
      }
      if (input.metadata) {
        subscriptionData.metadata = input.metadata;
      }
      // See createCheckoutSession — same hosted-vs-embedded url shape.
      const urlParams: Pick<
        Stripe.Checkout.SessionCreateParams,
        "ui_mode" | "return_url" | "success_url" | "cancel_url"
      > =
        input.uiMode === "embedded"
          ? {
              ui_mode: "embedded_page",
              ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
            }
          : {
              ...(input.successUrl ? { success_url: input.successUrl } : {}),
              ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
            };
      return call(
        "/v1/checkout/sessions",
        () =>
          stripe.checkout.sessions.create(
            {
              mode: "subscription",
              client_reference_id: input.clientReferenceId,
              line_items: [{ price: input.priceId, quantity: 1 }],
              payment_method_types: ["card"],
              ...urlParams,
              // VAT/GST readiness (global-launch item 7): collect a billing
              // address so the teacher's country + address is captured for
              // later tax computation.
              billing_address_collection: input.billingAddressCollection ?? "required",
              ...(input.customerAccountId
                ? {
                    // Bill the Account itself. `customer_update` is not valid
                    // here — there is no Customer object to write an address
                    // back onto; the Account already holds her identity.
                    customer_account: input.customerAccountId,
                  }
                : input.customerId
                  ? {
                      customer: input.customerId,
                      // Persist the collected address (and name) back onto the
                      // existing Customer so it's available on future invoices
                      // + tax computation. `customer_update` is only valid when
                      // a `customer` is passed; the customer_email path below
                      // lets Stripe create the Customer with the collected
                      // address automatically.
                      customer_update: { address: "auto", name: "auto" },
                    }
                  : input.customerEmail
                    ? { customer_email: input.customerEmail }
                    : {}),
              ...(input.automaticTax ? { automatic_tax: { enabled: true } } : {}),
              ...(input.allowPromotionCodes ? { allow_promotion_codes: true } : {}),
              ...(Object.keys(subscriptionData).length > 0
                ? { subscription_data: subscriptionData }
                : {}),
              metadata: input.metadata,
            },
            // `clientReferenceId` here is the teacher's own id (stable across
            // every checkout attempt they ever make), unlike the one-off
            // student checkout above where it's a fresh per-payment-row UUID.
            // Keying idempotency on clientReferenceId alone meant switching
            // plans (a different priceId) within Stripe's ~24h idempotency
            // cache window replayed the FIRST attempt's key with different
            // params and Stripe correctly rejected it with a 400 ("Keys for
            // idempotent requests can only be used with the same parameters
            // they were first used with") — Sentry SPIRALCLASS-2K/SPIRALCLASS-N.
            // Folding priceId in still dedupes a same-plan double-submit
            // (the original intent) while giving a genuinely different
            // checkout its own key.
            idem(`bcs-${input.clientReferenceId}-${input.priceId}`),
          ),
        stripeCheckoutSessionSchema,
      );
    },

    async getSubscription(subscriptionId) {
      return call(
        "/v1/subscriptions",
        () => stripe.subscriptions.retrieve(subscriptionId),
        stripeSubscriptionSchema,
      );
    },

    async cancelSubscriptionAtPeriodEnd(subscriptionId) {
      // Cancel at period end (no proration) — the documented annual-cancel
      // policy. The subscription stays active until current_period_end.
      return call(
        "/v1/subscriptions",
        () => stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true }, idem()),
        stripeSubscriptionSchema,
      );
    },

    async createBillingPortalSession(input) {
      // The portal accepts an Account as the customer, so a teacher billed
      // against her own v2 Account can still manage her card and cancel.
      // Exactly one of the two must be set; the caller resolves which.
      const target = input.customerAccountId
        ? { customer_account: input.customerAccountId }
        : { customer: input.customerId as string };
      return call(
        "/v1/billing_portal/sessions",
        () =>
          stripe.billingPortal.sessions.create(
            {
              ...target,
              return_url: input.returnUrl,
              ...(input.configurationId ? { configuration: input.configurationId } : {}),
            },
            idem(),
          ),
        stripeBillingPortalSessionSchema,
      );
    },

    async getInvoice(invoiceId) {
      return call("/v1/invoices", () => stripe.invoices.retrieve(invoiceId), stripeInvoiceSchema);
    },
  };
}

export class StripeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly path: string,
  ) {
    super(`Stripe API ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = "StripeApiError";
  }
}

// Stripe returns this on POST /v1/accounts when the platform account
// itself has not enabled Connect in the Stripe dashboard. It's a
// one-time operator misconfiguration, not a user-facing bug — we
// surface a friendly message rather than letting it page on-call.
export function isStripeConnectNotEnabledError(err: unknown): boolean {
  return (
    err instanceof StripeApiError &&
    err.status === 400 &&
    // Account creation moved to /v2/core/accounts at D-143. Both paths are
    // matched rather than just the new one: the platform-not-onboarded 400 is
    // the same condition whichever endpoint surfaces it, and a stale error
    // captured before the cutover should still be recognised.
    (err.path === "/v2/core/accounts" || err.path === "/v1/accounts") &&
    err.body.includes("signed up for Connect")
  );
}

// The teacher row carries a `stripe_account_id` this platform cannot see.
//
// Accounts v2 has no OAuth, so a platform can only ever act on accounts it
// created itself (D-143, PR 946). An id that arrived any other way — a teacher's
// own pre-existing account, an id copied between environments, an account
// created under the pre-D-58 Mexican platform entity — is permanently
// unreachable, and every call that passes it as `account` 400s with
// `resource_missing` / `account_invalid`. Real instance: acct_1ExampleTeacher0
// on POST /v1/account_sessions, which wedged /settings/payments for the
// teacher whose row held it (Sentry AGENDAPROFE-31, 12 events).
//
// Callers must translate this into a distinct user-facing state, and must NOT
// react by minting a replacement account — see the note in
// ensureConnectedAccount. Matched on the error code rather than the endpoint:
// the same condition surfaces from account_sessions, account_links and
// accounts.retrieve alike.
export function isStripeAccountUnreachableError(err: unknown): boolean {
  return (
    err instanceof StripeApiError &&
    err.status >= 400 &&
    err.status < 500 &&
    (err.body.includes('"code": "resource_missing"') ||
      err.body.includes('"code":"resource_missing"') ||
      err.body.includes("account_invalid")) &&
    // Scope to the account-scoped param so an unrelated resource_missing (a
    // bad price id, a stale checkout session) isn't misreported as a broken
    // Connect link.
    (err.body.includes('"param": "account"') ||
      err.body.includes('"param":"account"') ||
      err.body.includes("No such account"))
  );
}
