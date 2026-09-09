import { beforeEach, describe, expect, it, vi } from "vitest";

// The "Upgrade to Pro" service. Platform-account subscription Checkout (NOT
// Connect). Pin: the billing-creds gate, the founding cohort-closed gate, the
// missing-price-config guard, lazy platform-Customer creation, and the
// success/no-url branches. The Stripe + service deps are stubbed.

const state = {
  hasCreds: true,
  teacher: {
    id: "t1",
    email: "mira@x.com",
    name: "Mira",
    country: "MX",
    stripeAccountId: null,
  } as {
    id: string;
    email: string;
    name: string;
    // D-143: both feed the billing-account resolver — country to mint a
    // customer-only Account, stripeAccountId to reuse the one she has.
    country: string;
    stripeAccountId: string | null;
  } | null,
  cohortOpen: true,
  priceId: "price_monthly" as string | undefined,
  customerId: null as string | null,
  sessionUrl: "https://billing/checkout" as string | null,
  // Her existing subscription row, which the double-subscription guard reads.
  // Defaults to a brand-new teacher on Free with nothing at Stripe.
  stripeSubscriptionId: null as string | null,
  plan: "free" as "free" | "monthly" | "annual" | "founding",
  status: "free" as "free" | "trialing" | "active" | "past_due" | "canceled",
  comped: false,
  trialEndsAt: null as Date | null,
  currentPeriodEnd: null as Date | null,
};

vi.mock("@/lib/env", () => ({
  hasBillingCreds: () => state.hasCreds,
  billingPriceIds: () => ({ monthly: state.priceId, annual: "price_annual", founding: "price_f" }),
  serverEnv: () => ({ APP_URL: "https://spiralclass.com" }),
}));

const createBillingCustomer = vi.fn(async () => ({ id: "cus_new" }));
// D-143: a teacher with no Stripe account yet gets a customer-configuration
// -only v2 Account rather than a platform Customer.
const createCustomerAccount = vi.fn(async () => ({ id: "acct_new" }));
const createBillingCheckoutSession = vi.fn(async (_arg: { customerId: string }) => ({
  id: "cs_1",
  url: state.sessionUrl,
}));
vi.mock("@/lib/stripe", () => ({
  getStripeClient: () => ({
    createBillingCustomer,
    createCustomerAccount,
    createBillingCheckoutSession,
  }),
}));

vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent: vi.fn(), flushAnalytics: vi.fn() }));

const subUpdate = vi.fn(async () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: { findUnique: vi.fn(async () => state.teacher) },
    teacherSubscription: { update: subUpdate },
  },
}));

const ensureSubscriptionForTeacher = vi.fn(async () => ({
  stripeCustomerId: state.customerId,
  // The full row, because the double-subscription guard reads the lifecycle
  // fields off it. Returning only `stripeCustomerId` (as this did) left every
  // one of those undefined, which is exactly the shape that made the guard
  // look unnecessary.
  stripeSubscriptionId: state.stripeSubscriptionId,
  plan: state.plan,
  status: state.status,
  comped: state.comped,
  trialEndsAt: state.trialEndsAt,
  currentPeriodEnd: state.currentPeriodEnd,
}));
const getFoundingCohortState = vi.fn(async () => ({ isOpen: state.cohortOpen }));
vi.mock("@/lib/subscriptions/service", () => ({
  ensureSubscriptionForTeacher,
  getFoundingCohortState,
}));

const { startBillingCheckout } = await import("@/lib/subscriptions/start-billing-checkout");

beforeEach(() => {
  vi.clearAllMocks();
  state.hasCreds = true;
  state.teacher = {
    id: "t1",
    email: "mira@x.com",
    name: "Mira",
    country: "MX",
    stripeAccountId: null,
  };
  state.cohortOpen = true;
  state.priceId = "price_monthly";
  state.customerId = null;
  state.sessionUrl = "https://billing/checkout";
  state.stripeSubscriptionId = null;
  state.plan = "free";
  state.status = "free";
  state.comped = false;
  state.trialEndsAt = null;
  state.currentPeriodEnd = null;
});

// NEVER SELL A SECOND SUBSCRIPTION TO SOMEONE WHO ALREADY HAS ONE.
//
// Nothing checked before, and the UI was the only thing between a teacher and
// paying twice. Stripe's idempotency key is (teacher, price), so it dedupes a
// double-click on the SAME plan and does nothing for a different one: monthly,
// then annual from a stale second tab, was two live subscriptions and two
// charges a month, with no code path that reconciles them.
describe("startBillingCheckout — the double-subscription guard", () => {
  it("refuses a second subscription for an active subscriber", async () => {
    state.stripeSubscriptionId = "sub_live";
    state.plan = "monthly";
    state.status = "active";

    const res = await startBillingCheckout({ teacherId: "t1", plan: "annual", locale: "en" });

    expect(res).toHaveProperty("error");
    expect(createBillingCheckoutSession).not.toHaveBeenCalled();
  });

  // The cross-plan case specifically: the idempotency key folds in the price
  // id, so switching plans is a genuinely different key and Stripe would have
  // happily minted a second session.
  it("refuses even when the plan differs from the one she is on", async () => {
    state.stripeSubscriptionId = "sub_live";
    state.plan = "annual";
    state.status = "active";

    expect(
      await startBillingCheckout({ teacherId: "t1", plan: "monthly", locale: "en" }),
    ).toHaveProperty("error");
    expect(createBillingCheckoutSession).not.toHaveBeenCalled();
  });

  // The answer to a failed payment is a new card in the portal, never a second
  // subscription beside the unpaid one.
  it("refuses while a payment is past due", async () => {
    state.stripeSubscriptionId = "sub_live";
    state.plan = "monthly";
    state.status = "past_due";
    state.currentPeriodEnd = new Date(Date.now() + 24 * 60 * 60 * 1000);

    expect(
      await startBillingCheckout({ teacherId: "t1", plan: "monthly", locale: "en" }),
    ).toHaveProperty("error");
    expect(createBillingCheckoutSession).not.toHaveBeenCalled();
  });

  it("refuses a comped account, which already has Pro at no charge", async () => {
    state.comped = true;

    expect(
      await startBillingCheckout({ teacherId: "t1", plan: "monthly", locale: "en" }),
    ).toHaveProperty("error");
    expect(createBillingCheckoutSession).not.toHaveBeenCalled();
  });

  // THE regression risk in the guard itself. `dropToFree` deliberately leaves
  // `stripeSubscriptionId` on the row, so a churned teacher still carries her
  // old id — a guard keyed on the id being present would lock her out of ever
  // coming back, which is worse than the bug it fixes.
  it("lets a lapsed teacher who still carries her old subscription id re-subscribe", async () => {
    state.stripeSubscriptionId = "sub_from_last_time";
    state.plan = "free";
    state.status = "free";

    const res = await startBillingCheckout({ teacherId: "t1", plan: "monthly", locale: "en" });

    expect(res).not.toHaveProperty("error");
    expect(createBillingCheckoutSession).toHaveBeenCalled();
  });

  it("lets a trialing teacher subscribe — a trial has no Stripe subscription yet", async () => {
    state.status = "trialing";
    state.trialEndsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

    const res = await startBillingCheckout({ teacherId: "t1", plan: "monthly", locale: "en" });

    expect(res).not.toHaveProperty("error");
    expect(createBillingCheckoutSession).toHaveBeenCalled();
  });
});

// Every error string on the money path used to be `locale === "en" ? en : es`,
// so a French teacher hit a Spanish wall at checkout — the same two-branch
// shape that put "Pro Mensual" on her plan card.
describe("startBillingCheckout — error copy is localized, not en/es", () => {
  it("speaks French to a French teacher", async () => {
    state.hasCreds = false;

    const fr = await startBillingCheckout({ teacherId: "t1", plan: "monthly", locale: "fr" });
    const es = await startBillingCheckout({ teacherId: "t1", plan: "monthly", locale: "es-MX" });

    const frError = "error" in fr ? fr.error : "";
    const esError = "error" in es ? es.error : "";
    expect(frError).toContain("abonnements");
    expect(frError).not.toBe(esError);
  });

  // The old copy put `STRIPE_PRICE_MONTHLY` on screen — in Spanish only,
  // beside an untranslated plan id.
  it("does not name an env var or an internal plan id to the teacher", async () => {
    state.priceId = undefined;

    const res = await startBillingCheckout({ teacherId: "t1", plan: "monthly", locale: "es-MX" });

    expect(res).toHaveProperty("error");
    const message = "error" in res ? res.error : "";
    expect(message).not.toContain("STRIPE_PRICE");
    expect(message).not.toContain("monthly");
  });
});

describe("startBillingCheckout", () => {
  it("refuses when billing creds are missing", async () => {
    state.hasCreds = false;
    // Every failure now carries a stable code beside the localized sentence,
    // so a caller that has to survive a round trip has something language-free
    // to pass (see openBillingPortal's redirect).
    expect(await startBillingCheckout({ teacherId: "t1", plan: "monthly", locale: "en" })).toEqual({
      error: expect.any(String),
      code: "unavailable",
    });
  });

  it("errors when the teacher row is gone", async () => {
    state.teacher = null;
    expect(
      await startBillingCheckout({ teacherId: "t1", plan: "monthly", locale: "en" }),
    ).toHaveProperty("error");
  });

  it("refuses founding when the cohort is closed", async () => {
    state.cohortOpen = false;
    const res = await startBillingCheckout({ teacherId: "t1", plan: "founding", locale: "en" });
    expect(res).toHaveProperty("error");
    expect(createBillingCheckoutSession).not.toHaveBeenCalled();
  });

  it("errors when the plan price isn't configured", async () => {
    state.priceId = undefined;
    expect(
      await startBillingCheckout({ teacherId: "t1", plan: "monthly", locale: "en" }),
    ).toHaveProperty("error");
  });

  // D-143 inverted this: it used to create a platform Customer. Her own v2
  // Account is the billing customer now, so no Customer object is created for
  // anyone — which is the concrete payoff of choosing Accounts v2, since there
  // is no Account-to-Customer mapping left to keep in step.
  it("creates a customer-only Account once and redirects to the session", async () => {
    const res = await startBillingCheckout({ teacherId: "t1", plan: "monthly", locale: "es-MX" });
    expect(createCustomerAccount).toHaveBeenCalledTimes(1);
    expect(createBillingCustomer).not.toHaveBeenCalled();
    expect(subUpdate).toHaveBeenCalledWith({
      where: { teacherId: "t1" },
      data: { stripeCustomerId: "acct_new" },
    });
    expect(res).toEqual({ mode: "redirect", redirectTo: "https://billing/checkout" });
  });

  it("bills a CONNECTED teacher against the account she already has", async () => {
    // The whole point: she is already a merchant on that Account, and it
    // carries the `customer` configuration too. Minting a second object for the
    // same person is exactly what v2 exists to avoid.
    state.teacher = {
      id: "t1",
      email: "mira@x.com",
      name: "Mira",
      country: "MX",
      stripeAccountId: "acct_merchant",
    };
    await startBillingCheckout({ teacherId: "t1", plan: "monthly", locale: "en" });
    expect(createCustomerAccount).not.toHaveBeenCalled();
    expect(subUpdate).toHaveBeenCalledWith({
      where: { teacherId: "t1" },
      data: { stripeCustomerId: "acct_merchant" },
    });
    const arg = createBillingCheckoutSession.mock.calls[0][0] as { customerAccountId?: string };
    expect(arg.customerAccountId).toBe("acct_merchant");
  });

  it("still bills a LEGACY subscriber against their platform Customer", async () => {
    // Someone who subscribed before D-143 keeps their `cus_`. Branching on the
    // id prefix rather than a stored flag means the two cannot drift apart.
    state.customerId = "cus_existing";
    await startBillingCheckout({ teacherId: "t1", plan: "annual", locale: "en" });
    expect(createCustomerAccount).not.toHaveBeenCalled();
    expect(createBillingCustomer).not.toHaveBeenCalled();
    const arg = createBillingCheckoutSession.mock.calls[0][0] as {
      customerId: string;
      automaticTax: boolean;
    };
    expect(arg.customerId).toBe("cus_existing");
    // VAT/GST readiness is capture-only: tax computation off by default (the
    // billing address is still collected + written back onto the Customer by
    // the client).
    expect(arg.automaticTax).toBe(false);
  });

  it("errors when Stripe returns no checkout url", async () => {
    state.sessionUrl = null;
    expect(
      await startBillingCheckout({ teacherId: "t1", plan: "monthly", locale: "en" }),
    ).toHaveProperty("error");
  });
});
