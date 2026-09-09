import type {
  CreateAccountLinkInput,
  CreateAccountSessionInput,
  CreateBillingCheckoutSessionInput,
  CreateBillingCustomerInput,
  CreateBillingPortalSessionInput,
  CreateCheckoutSessionInput,
  EnsureCheckoutCustomerInput,
  CreateConnectedAccountInput,
  CreateCustomerAccountInput,
  CreatePaymentIntentInput,
  CreateRefundInput,
  StripeClient,
} from "./client";
import type {
  SettledCharge,
  StripeAccount,
  StripeAccountLink,
  StripeAccountSession,
  StripeBillingPortalSession,
  StripeCharge,
  StripeCheckoutSession,
  StripeCustomer,
  StripeInvoice,
  StripePaymentIntent,
  StripeRefund,
  StripeSubscription,
} from "./types";

// In-memory stub used by tests + by dev when STRIPE_SECRET_KEY isn't
// configured. Behavior is deterministic and callers can inject objects
// via `seed*` to simulate webhook flows.

export type StubStripeClient = StripeClient & {
  seedAccount(account: StripeAccount): void;
  seedCheckoutSession(session: StripeCheckoutSession): void;
  seedPaymentIntent(intent: StripePaymentIntent): void;
  // Simulate a settled charge so getSettledCharge returns a known net.
  seedSettledCharge(paymentIntentId: string, settled: SettledCharge): void;
  // Simulate a charge so getCharge (the UAT Stripe check, D-55) returns it.
  seedCharge(charge: StripeCharge): void;
  // Billing seams.
  seedSubscription(subscription: StripeSubscription): void;
  seedInvoice(invoice: StripeInvoice): void;
  // Seed a full platform Customer (incl. billing address) so getBillingCustomer
  // returns it — used to exercise the VAT/GST address capture on the sub rail.
  seedBillingCustomer(customer: StripeCustomer): void;
  // Lookups for tests that want to assert what was created.
  getCheckoutSessions(): Array<{ id: string; clientReferenceId: string }>;
  getRefunds(): Array<{ id: string; paymentIntentId: string }>;
  getBillingCustomers(): Array<{ id: string; email: string }>;
  getPortalSessions(): Array<{ id: string; customerId: string }>;
  reset(): void;
};

export function createStubStripeClient(): StubStripeClient {
  const accounts = new Map<string, StripeAccount>();
  const sessions = new Map<string, StripeCheckoutSession>();
  const sessionLog: Array<{
    id: string;
    clientReferenceId: string;
    input: CreateCheckoutSessionInput;
  }> = [];
  const intents = new Map<string, StripePaymentIntent>();
  const refunds: Array<{ id: string; paymentIntentId: string }> = [];
  const settledCharges = new Map<string, SettledCharge>();
  const charges = new Map<string, StripeCharge>();
  const subscriptions = new Map<string, StripeSubscription>();
  const invoices = new Map<string, StripeInvoice>();
  // Checkout Customers live on the TEACHER's account, so they are keyed by
  // account AND email — two teachers sharing a student must not collide.
  const checkoutCustomers = new Map<string, string>();
  let checkoutCustomerSeq = 1;
  const customers: Array<{ id: string; email: string }> = [];
  // Full Customer objects (incl. address) keyed by id, so getBillingCustomer
  // can return the billing address captured on the subscription Checkout.
  const billingCustomersById = new Map<string, StripeCustomer>();
  const portalSessions: Array<{ id: string; customerId: string }> = [];

  let acctSeq = 1;
  let csSeq = 1;
  let piSeq = 1;
  let reSeq = 1;
  let cusSeq = 1;
  let bpsSeq = 1;

  return {
    async createConnectedAccount(input: CreateConnectedAccountInput): Promise<StripeAccount> {
      const id = `acct_STUB${acctSeq++}`;
      const account: StripeAccount = {
        id,
        // Stub accounts start un-verified — flip via seedAccount when a
        // test wants to simulate a completed onboarding.
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
      };
      accounts.set(id, account);
      void input;
      return account;
    },

    // Customer-configuration-only account (D-143): billable, not a merchant.
    // The stub returns just an id, matching the real client — there is no v1
    // shape for an account with no merchant configuration.
    async createCustomerAccount(input: CreateCustomerAccountInput): Promise<{ id: string }> {
      void input;
      return { id: `acct_STUBCUST${acctSeq++}` };
    },

    async getConnectedAccount(accountId: string): Promise<StripeAccount> {
      const a = accounts.get(accountId);
      if (!a) throw new Error(`stub: unknown account ${accountId}`);
      return a;
    },

    async createAccountLink(input: CreateAccountLinkInput): Promise<StripeAccountLink> {
      return {
        url: `https://stub.stripe/connect/${encodeURIComponent(input.accountId)}/${input.type}`,
        expires_at: Math.floor(Date.now() / 1000) + 5 * 60,
      };
    },

    async createAccountSession(input: CreateAccountSessionInput): Promise<StripeAccountSession> {
      return { client_secret: `accs_STUB_${input.accountId}_secret` };
    },

    // Mirrors the real client's find-or-create so a test can assert a returning
    // student reuses one Customer rather than growing one per purchase.
    async ensureCheckoutCustomer(input: EnsureCheckoutCustomerInput): Promise<string> {
      const scope = `${input.connectedAccountId}:${input.email}`;
      const existing = checkoutCustomers.get(scope);
      if (existing) return existing;
      const id = `cus_STUB${checkoutCustomerSeq++}`;
      checkoutCustomers.set(scope, id);
      return id;
    },

    async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<StripeCheckoutSession> {
      const id = `cs_STUB${csSeq++}_${input.clientReferenceId.slice(0, 8)}`;
      const session: StripeCheckoutSession = {
        id,
        status: "open",
        payment_status: "unpaid",
        mode: "payment",
        ...(input.uiMode === "embedded"
          ? { client_secret: `${id}_secret_STUB`, url: null }
          : { url: `https://stub.stripe/checkout/${id}` }),
        client_reference_id: input.clientReferenceId,
        payment_intent: null,
        customer: input.customerId ?? null,
        metadata: input.metadata ?? null,
        amount_total: input.lineItem.amountMinorUnits,
        currency: input.lineItem.currency,
      };
      sessions.set(id, session);
      sessionLog.push({ id, clientReferenceId: input.clientReferenceId, input });
      return session;
    },

    async getCheckoutSession(sessionId: string): Promise<StripeCheckoutSession> {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`stub: unknown checkout session ${sessionId}`);
      return s;
    },

    async expireCheckoutSession(sessionId: string): Promise<StripeCheckoutSession> {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`stub: unknown checkout session ${sessionId}`);
      const expired: StripeCheckoutSession = {
        ...s,
        status: "expired",
        payment_status: "unpaid",
      };
      sessions.set(sessionId, expired);
      return expired;
    },

    async createPaymentIntent(input: CreatePaymentIntentInput): Promise<StripePaymentIntent> {
      const id = `pi_STUB${piSeq++}`;
      const intent: StripePaymentIntent = {
        id,
        status: "requires_payment_method",
        amount: input.amountMinorUnits,
        currency: input.currency,
        client_secret: `${id}_secret_STUB`,
        metadata: input.metadata ?? null,
      };
      intents.set(id, intent);
      return intent;
    },

    async getPaymentIntent(paymentIntentId: string): Promise<StripePaymentIntent> {
      const pi = intents.get(paymentIntentId);
      if (!pi) throw new Error(`stub: unknown payment intent ${paymentIntentId}`);
      return pi;
    },

    async createRefund(input: CreateRefundInput): Promise<StripeRefund> {
      const id = `re_STUB${reSeq++}`;
      const refund: StripeRefund = {
        id,
        status: "succeeded",
        amount: intents.get(input.paymentIntentId)?.amount,
        payment_intent: input.paymentIntentId,
      };
      refunds.push({ id, paymentIntentId: input.paymentIntentId });
      return refund;
    },

    async getSettledCharge(paymentIntentId: string): Promise<SettledCharge | null> {
      return settledCharges.get(paymentIntentId) ?? null;
    },

    async getCharge(chargeId: string): Promise<StripeCharge> {
      const c = charges.get(chargeId);
      if (!c) throw new Error(`stub: unknown charge ${chargeId}`);
      return c;
    },

    // ----- Billing -----

    async createBillingCustomer(input: CreateBillingCustomerInput): Promise<StripeCustomer> {
      const id = `cus_STUB${cusSeq++}`;
      customers.push({ id, email: input.email });
      const customer: StripeCustomer = {
        id,
        email: input.email,
        name: input.name ?? null,
        metadata: input.metadata ?? null,
      };
      billingCustomersById.set(id, customer);
      return customer;
    },

    async getBillingCustomer(customerId: string): Promise<StripeCustomer> {
      const seeded = billingCustomersById.get(customerId);
      if (seeded) return seeded;
      const c = customers.find((x) => x.id === customerId);
      if (!c) throw new Error(`stub: unknown customer ${customerId}`);
      return { id: c.id, email: c.email };
    },

    async createBillingCheckoutSession(
      input: CreateBillingCheckoutSessionInput,
    ): Promise<StripeCheckoutSession> {
      const id = `cs_BSTUB${csSeq++}_${input.clientReferenceId.slice(0, 8)}`;
      const session: StripeCheckoutSession = {
        id,
        status: "open",
        payment_status: "unpaid",
        mode: "subscription",
        ...(input.uiMode === "embedded"
          ? { client_secret: `${id}_secret_STUB`, url: null }
          : { url: `https://stub.stripe/billing-checkout/${id}` }),
        client_reference_id: input.clientReferenceId,
        payment_intent: null,
        customer: input.customerId ?? null,
        metadata: input.metadata ?? null,
        amount_total: null,
        currency: "mxn",
      };
      // Intentionally not added to sessionLog (that log is the one-off package
      // checkout assertion surface); billing sessions are asserted via the URL.
      sessions.set(id, session);
      return session;
    },

    async getSubscription(subscriptionId: string): Promise<StripeSubscription> {
      const s = subscriptions.get(subscriptionId);
      if (!s) throw new Error(`stub: unknown subscription ${subscriptionId}`);
      return s;
    },

    async cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<StripeSubscription> {
      const s = subscriptions.get(subscriptionId);
      if (!s) throw new Error(`stub: unknown subscription ${subscriptionId}`);
      const next = { ...s, cancel_at_period_end: true };
      subscriptions.set(subscriptionId, next);
      return next;
    },

    async createBillingPortalSession(
      input: CreateBillingPortalSessionInput,
    ): Promise<StripeBillingPortalSession> {
      const id = `bps_STUB${bpsSeq++}`;
      // Records whichever id the caller billed against — an `acct_` since D-143,
      // a legacy `cus_` before it — so a test can assert the Account path was
      // taken rather than a Customer silently created.
      portalSessions.push({ id, customerId: input.customerAccountId ?? input.customerId ?? "" });
      return { id, url: `https://stub.stripe/portal/${id}` };
    },

    async getInvoice(invoiceId: string): Promise<StripeInvoice> {
      const i = invoices.get(invoiceId);
      if (!i) throw new Error(`stub: unknown invoice ${invoiceId}`);
      return i;
    },

    seedSubscription(subscription) {
      subscriptions.set(subscription.id, subscription);
    },
    seedInvoice(invoice) {
      invoices.set(invoice.id, invoice);
    },
    seedBillingCustomer(customer) {
      billingCustomersById.set(customer.id, customer);
      customers.push({ id: customer.id, email: customer.email ?? "" });
    },
    getBillingCustomers() {
      return [...customers];
    },
    getPortalSessions() {
      return [...portalSessions];
    },

    seedSettledCharge(paymentIntentId, settled) {
      settledCharges.set(paymentIntentId, settled);
    },
    seedCharge(charge) {
      if (!charge.id) throw new Error("seedCharge: charge.id is required");
      charges.set(charge.id, charge);
    },
    seedAccount(account) {
      accounts.set(account.id, account);
    },
    seedCheckoutSession(session) {
      sessions.set(session.id, session);
    },
    seedPaymentIntent(intent) {
      intents.set(intent.id, intent);
    },
    getCheckoutSessions() {
      return sessionLog.map((s) => ({ id: s.id, clientReferenceId: s.clientReferenceId }));
    },
    getRefunds() {
      return [...refunds];
    },
    reset() {
      accounts.clear();
      sessions.clear();
      sessionLog.length = 0;
      intents.clear();
      refunds.length = 0;
      settledCharges.clear();
      charges.clear();
      subscriptions.clear();
      invoices.clear();
      customers.length = 0;
      checkoutCustomers.clear();
      billingCustomersById.clear();
      portalSessions.length = 0;
      acctSeq = 1;
      csSeq = 1;
      piSeq = 1;
      reSeq = 1;
      cusSeq = 1;
      bpsSeq = 1;
      checkoutCustomerSeq = 1;
    },
  };
}
