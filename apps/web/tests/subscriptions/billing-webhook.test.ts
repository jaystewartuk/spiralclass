import { describe, expect, it } from "vitest";
import { handleBillingWebhook } from "@/lib/subscriptions/billing-webhook-handler";
import { createStubStripeClient } from "@/lib/stripe/stub";
import { makeFakePrisma, type FakeSub } from "./_fake-prisma";

const PRICE_IDS = { monthly: "price_m", annual: "price_a", founding: "price_f" };

function baseSub(teacherId: string, partial: Partial<FakeSub> = {}): FakeSub {
  return {
    teacherId,
    plan: "free",
    status: "trialing",
    lockedPriceMinorUnits: null,
    currency: "MXN",
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: null,
    trialEndsAt: new Date("2026-07-01T00:00:00Z"),
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    comped: false,
    ...partial,
  };
}

function envelope(type: string, object: unknown) {
  return { id: `evt_${Math.random().toString(36).slice(2)}`, type, data: { object } };
}

describe("billing webhook → lifecycle", () => {
  it("invoice.paid records a paid invoice (net = amount − fee) and activates", async () => {
    const fake = makeFakePrisma({ subs: [baseSub("t1")] });
    const stripe = createStubStripeClient();
    stripe.seedSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      currency: "gbp",
      current_period_end: Math.floor(new Date("2026-07-12T00:00:00Z").getTime() / 1000),
      items: { data: [{ price: { id: "price_m" } }] },
    });
    stripe.seedSettledCharge("pi_1", {
      chargeId: "ch_1",
      netMinorUnits: 19_000,
      feeMinorUnits: 900,
      currency: "mxn",
    });

    const outcome = await handleBillingWebhook(
      envelope("invoice.paid", {
        id: "in_1",
        customer: "cus_1",
        subscription: "sub_1",
        amount_paid: 19_900,
        payment_intent: "pi_1",
        period_start: Math.floor(new Date("2026-06-12T00:00:00Z").getTime() / 1000),
        period_end: Math.floor(new Date("2026-07-12T00:00:00Z").getTime() / 1000),
        status: "paid",
      }),
      { prisma: fake.db, stripe, priceIds: PRICE_IDS, now: () => new Date("2026-06-12T00:00:00Z") },
    );

    expect(outcome).toMatchObject({ code: "applied", action: "invoice-paid", teacherId: "t1" });
    expect(fake.subs.get("t1")!.status).toBe("active");
    expect(fake.subs.get("t1")!.plan).toBe("monthly");
    const invoice = fake.invoices[0];
    expect(invoice.status).toBe("paid");
    expect(invoice.amountMinorUnits).toBe(19_900);
    expect(invoice.feeMinorUnits).toBe(900);
    expect(invoice.netMinorUnits).toBe(19_000); // amount − fee
    // Receipt notification enqueued.
    expect(
      fake.notifications.some((n) => n.templateName === "subscription_payment_succeeded"),
    ).toBe(true);
  });

  // Regression: when the fee couldn't be read (balance-transaction lag — the
  // charge exists but getSettledCharge returns null for a beat), the handler
  // swallowed it, recorded netMinorUnits = full gross, and returned success, so
  // the event was never reprocessed and the ambassador commission base was
  // permanently inflated. It must now THROW (retryable) and record nothing.
  it("invoice.paid throws (retryable) when the fee can't be read yet, instead of recording net = gross", async () => {
    const fake = makeFakePrisma({ subs: [baseSub("t1", { plan: "monthly", status: "active" })] });
    const stripe = createStubStripeClient();
    // Intentionally do NOT seed the settled charge → getSettledCharge returns null.
    await expect(
      handleBillingWebhook(
        envelope("invoice.paid", {
          id: "in_lag",
          customer: "cus_1",
          subscription: "sub_1",
          amount_paid: 19_900,
          payment_intent: "pi_unsettled",
          period_start: Math.floor(new Date("2026-06-12T00:00:00Z").getTime() / 1000),
          period_end: Math.floor(new Date("2026-07-12T00:00:00Z").getTime() / 1000),
          status: "paid",
        }),
        {
          prisma: fake.db,
          stripe,
          priceIds: PRICE_IDS,
          now: () => new Date("2026-06-12T00:00:00Z"),
        },
      ),
    ).rejects.toThrow(/billing-fee-not-settled-yet/);
    // Nothing persisted with a wrong net — the retry records it once the fee reads.
    expect(fake.invoices).toHaveLength(0);
  });

  it("invoice.payment_failed → past_due + a failed invoice row", async () => {
    const fake = makeFakePrisma({
      subs: [baseSub("t1", { plan: "monthly", status: "active" })],
    });
    const stripe = createStubStripeClient();
    const outcome = await handleBillingWebhook(
      envelope("invoice.payment_failed", {
        id: "in_2",
        customer: "cus_1",
        subscription: "sub_1",
        amount_due: 19_900,
        status: "open",
        period_end: Math.floor(new Date("2026-07-12T00:00:00Z").getTime() / 1000),
      }),
      { prisma: fake.db, stripe, priceIds: PRICE_IDS },
    );
    expect(outcome).toMatchObject({ code: "applied", action: "invoice-payment-failed" });
    expect(fake.subs.get("t1")!.status).toBe("past_due");
    expect(fake.invoices[0].status).toBe("failed");
  });

  it("customer.subscription.deleted → drop to Free", async () => {
    const fake = makeFakePrisma({
      subs: [baseSub("t1", { plan: "monthly", status: "active" })],
    });
    const stripe = createStubStripeClient();
    const outcome = await handleBillingWebhook(
      envelope("customer.subscription.deleted", {
        id: "sub_1",
        customer: "cus_1",
        status: "canceled",
        currency: "gbp",
      }),
      { prisma: fake.db, stripe, priceIds: PRICE_IDS },
    );
    expect(outcome).toMatchObject({ code: "applied", action: "subscription-deleted" });
    expect(fake.subs.get("t1")!.status).toBe("free");
    expect(fake.subs.get("t1")!.plan).toBe("free");
  });

  it("customer.subscription.updated active re-fetches Stripe and activates", async () => {
    const fake = makeFakePrisma({ subs: [baseSub("t1")] });
    const stripe = createStubStripeClient();
    stripe.seedSubscription({
      id: "sub_9",
      customer: "cus_1",
      status: "active",
      currency: "gbp",
      current_period_end: Math.floor(new Date("2026-07-12T00:00:00Z").getTime() / 1000),
      items: { data: [{ price: { id: "price_a" } }] },
    });
    const outcome = await handleBillingWebhook(
      envelope("customer.subscription.updated", {
        id: "sub_9",
        customer: "cus_1",
        status: "active",
        currency: "gbp",
      }),
      { prisma: fake.db, stripe, priceIds: PRICE_IDS },
    );
    expect(outcome).toMatchObject({ code: "applied" });
    expect(fake.subs.get("t1")!.plan).toBe("annual");
    expect(fake.subs.get("t1")!.status).toBe("active");
  });

  // Regression: Stripe does not guarantee webhook ordering — an invoice.paid
  // redelivered after customer.subscription.deleted used to re-activate the
  // canceled subscription (permanent free Pro, since no future webhook fires
  // for a canceled sub and the sweep only touches trialing/past_due rows).
  it("a late invoice.paid for a canceled subscription records the invoice but does not re-activate", async () => {
    const fake = makeFakePrisma({
      subs: [
        baseSub("t1", {
          plan: "free",
          status: "free",
          canceledAt: new Date("2026-06-10T00:00:00Z"),
        }),
      ],
    });
    const stripe = createStubStripeClient();
    stripe.seedSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "canceled",
      currency: "gbp",
      current_period_end: Math.floor(new Date("2026-07-12T00:00:00Z").getTime() / 1000),
      items: { data: [{ price: { id: "price_m" } }] },
    });

    const outcome = await handleBillingWebhook(
      envelope("invoice.paid", {
        id: "in_late",
        customer: "cus_1",
        subscription: "sub_1",
        amount_paid: 19_900,
        period_start: Math.floor(new Date("2026-06-12T00:00:00Z").getTime() / 1000),
        period_end: Math.floor(new Date("2026-07-12T00:00:00Z").getTime() / 1000),
        status: "paid",
      }),
      { prisma: fake.db, stripe, priceIds: PRICE_IDS, now: () => new Date("2026-06-12T01:00:00Z") },
    );

    expect(outcome).toMatchObject({ code: "applied", action: "invoice-paid" });
    // The money is recorded (real payment), but the row stays free.
    expect(fake.invoices[0]?.status).toBe("paid");
    expect(fake.subs.get("t1")!.status).toBe("free");
    expect(fake.subs.get("t1")!.plan).toBe("free");
  });

  // Regression: a monthly→founding upgrade inherited the monthly locked
  // price (799) instead of locking the founding price — the "price-locked"
  // founding member was locked at the wrong, higher price.
  it("founding upgrade locks the founding price, not a stale non-founding locked price", async () => {
    const fake = makeFakePrisma({
      subs: [baseSub("t1", { plan: "monthly", status: "active", lockedPriceMinorUnits: 799 })],
      cohort: { headcount: 0 },
    });
    const stripe = createStubStripeClient();
    stripe.seedSubscription({
      id: "sub_f",
      customer: "cus_1",
      status: "active",
      currency: "gbp",
      current_period_end: Math.floor(new Date("2026-07-12T00:00:00Z").getTime() / 1000),
      items: { data: [{ price: { id: "price_f" } }] },
    });
    const outcome = await handleBillingWebhook(
      envelope("customer.subscription.updated", {
        id: "sub_f",
        customer: "cus_1",
        status: "active",
        currency: "gbp",
      }),
      { prisma: fake.db, stripe, priceIds: PRICE_IDS },
    );
    expect(outcome).toMatchObject({ code: "applied" });
    expect(fake.subs.get("t1")!.plan).toBe("founding");
    expect(fake.subs.get("t1")!.lockedPriceMinorUnits).toBe(599);
    // A founding teacher's own locked price still survives a renewal.
    const again = await handleBillingWebhook(
      envelope("customer.subscription.updated", {
        id: "sub_f",
        customer: "cus_1",
        status: "active",
        currency: "gbp",
      }),
      { prisma: fake.db, stripe, priceIds: PRICE_IDS },
    );
    expect(again).toMatchObject({ code: "applied" });
    expect(fake.subs.get("t1")!.lockedPriceMinorUnits).toBe(599);
  });

  // A Customer Portal cancellation is NOT customer.subscription.deleted. Stripe
  // sends customer.subscription.updated with the status still `active` and
  // `cancel_at_period_end: true`, because she is paid through the period and
  // keeps Pro until it ends. The flag was parsed by stripeSubscriptionSchema
  // and then dropped on the floor, so the app could not tell this apart from an
  // ordinary renewal and the billing page kept promising a "Next charge".
  it("records a portal cancellation as pending, without ending the subscription", async () => {
    const fake = makeFakePrisma({
      subs: [baseSub("t1", { plan: "monthly", status: "active", stripeSubscriptionId: "sub_c" })],
    });
    const stripe = createStubStripeClient();
    const periodEnd = new Date("2026-07-12T00:00:00Z");
    stripe.seedSubscription({
      id: "sub_c",
      customer: "cus_1",
      status: "active",
      currency: "gbp",
      cancel_at_period_end: true,
      current_period_end: Math.floor(periodEnd.getTime() / 1000),
      items: { data: [{ price: { id: "price_m" } }] },
    });

    const outcome = await handleBillingWebhook(
      envelope("customer.subscription.updated", {
        id: "sub_c",
        customer: "cus_1",
        status: "active",
        currency: "gbp",
        cancel_at_period_end: true,
      }),
      { prisma: fake.db, stripe, priceIds: PRICE_IDS },
    );

    expect(outcome).toMatchObject({ code: "applied" });
    const row = fake.subs.get("t1")!;
    expect(row.cancelAtPeriodEnd).toBe(true);
    // Still Pro, still paid through the period — pending cancellation is not
    // cancellation, and `canceledAt` is what "it has actually ended" means.
    expect(row.status).toBe("active");
    expect(row.plan).toBe("monthly");
    expect(row.canceledAt).toBeNull();
    expect(row.currentPeriodEnd).toEqual(periodEnd);
  });

  // The flip BACK matters as much as the flip: "Resume subscription" in the
  // portal fires the same event with the flag false, and a write that only
  // fired on `true` would leave her reading "Ends 12 July" forever.
  it("clears the pending cancellation when she resumes", async () => {
    const fake = makeFakePrisma({
      subs: [
        baseSub("t1", {
          plan: "monthly",
          status: "active",
          stripeSubscriptionId: "sub_c",
          cancelAtPeriodEnd: true,
        }),
      ],
    });
    const stripe = createStubStripeClient();
    stripe.seedSubscription({
      id: "sub_c",
      customer: "cus_1",
      status: "active",
      currency: "gbp",
      // Stripe OMITS the field on a subscription that is not cancelling, so
      // this also pins that "absent" is read as "not cancelling".
      current_period_end: Math.floor(new Date("2026-07-12T00:00:00Z").getTime() / 1000),
      items: { data: [{ price: { id: "price_m" } }] },
    });

    await handleBillingWebhook(
      envelope("customer.subscription.updated", {
        id: "sub_c",
        customer: "cus_1",
        status: "active",
        currency: "gbp",
      }),
      { prisma: fake.db, stripe, priceIds: PRICE_IDS },
    );

    expect(fake.subs.get("t1")!.cancelAtPeriodEnd).toBe(false);
  });

  // The founding cohort is OUR rule, and a subscription can change price
  // outside checkout — the Customer Portal switches prices. The portal config
  // excludes the founding price so a subscriber cannot put herself on it, but
  // that exclusion lives in Stripe's configuration, a Dashboard edit changes
  // it, and the API does not echo the field back so it cannot be verified by
  // reading. This is the enforcement point we control.
  //
  // DETECT ONLY. The subscription really is on that price at Stripe, so
  // rewriting the plan here would make our row disagree with what she is
  // actually charged — a worse failure than the one being guarded.
  it("records a founding switch truthfully even when the cohort is shut, and does not silently rewrite it", async () => {
    const fake = makeFakePrisma({
      subs: [baseSub("t1", { plan: "monthly", status: "active", stripeSubscriptionId: "sub_f2" })],
      // Cohort shut: the cap is already met.
      cohort: { headcount: 50, maxTeachers: 50 },
    });
    const stripe = createStubStripeClient();
    stripe.seedSubscription({
      id: "sub_f2",
      customer: "cus_1",
      status: "active",
      currency: "gbp",
      current_period_end: Math.floor(new Date("2026-07-12T00:00:00Z").getTime() / 1000),
      items: { data: [{ price: { id: "price_f" } }] },
    });

    const outcome = await handleBillingWebhook(
      envelope("customer.subscription.updated", {
        id: "sub_f2",
        customer: "cus_1",
        status: "active",
        currency: "gbp",
      }),
      { prisma: fake.db, stripe, priceIds: PRICE_IDS },
    );

    expect(outcome).toMatchObject({ code: "applied" });
    const row = fake.subs.get("t1")!;
    // Truthful: she IS on the founding price at Stripe, so that is what we
    // record — the guard's job is to make it visible, not to invent a
    // different plan than the one being charged.
    expect(row.plan).toBe("founding");
    expect(row.lockedPriceMinorUnits).toBe(599);
  });

  // VAT/GST readiness (global-launch item 7): the subscription Checkout writes
  // the billing address back onto the platform Customer; on activation we read
  // it and persist country + address alongside the subscription.
  it("subscription.updated captures the billing country + address off the platform Customer", async () => {
    const fake = makeFakePrisma({ subs: [baseSub("t1")] });
    const stripe = createStubStripeClient();
    stripe.seedSubscription({
      id: "sub_b",
      customer: "cus_1",
      status: "active",
      currency: "gbp",
      current_period_end: Math.floor(new Date("2026-08-12T00:00:00Z").getTime() / 1000),
      items: { data: [{ price: { id: "price_m" } }] },
    });
    stripe.seedBillingCustomer({
      id: "cus_1",
      email: "mira@x.com",
      address: {
        line1: "Av. Reforma 1",
        line2: "",
        city: "CDMX",
        postal_code: "06600",
        country: "MX",
      },
    });

    const outcome = await handleBillingWebhook(
      envelope("customer.subscription.updated", {
        id: "sub_b",
        customer: "cus_1",
        status: "active",
        currency: "gbp",
      }),
      { prisma: fake.db, stripe, priceIds: PRICE_IDS },
    );
    expect(outcome).toMatchObject({ code: "applied" });
    expect(fake.subs.get("t1")!.billingCountry).toBe("MX");
    expect(fake.subs.get("t1")!.billingAddressJson).toEqual({
      line1: "Av. Reforma 1",
      city: "CDMX",
      postal_code: "06600",
      country: "MX",
    });
  });

  // A later activation without an address (e.g. Customer fetch fails) must not
  // wipe a previously-captured value.
  it("does not overwrite a captured address when the Customer has none", async () => {
    const fake = makeFakePrisma({
      subs: [baseSub("t1", { billingCountry: "MX", billingAddressJson: { country: "MX" } })],
    });
    const stripe = createStubStripeClient();
    stripe.seedSubscription({
      id: "sub_c",
      customer: "cus_1",
      status: "active",
      currency: "gbp",
      current_period_end: Math.floor(new Date("2026-08-12T00:00:00Z").getTime() / 1000),
      items: { data: [{ price: { id: "price_m" } }] },
    });
    // No billing customer seeded → getBillingCustomer throws → capture is null.
    await handleBillingWebhook(
      envelope("customer.subscription.updated", {
        id: "sub_c",
        customer: "cus_1",
        status: "active",
        currency: "gbp",
      }),
      { prisma: fake.db, stripe, priceIds: PRICE_IDS },
    );
    expect(fake.subs.get("t1")!.billingCountry).toBe("MX");
    expect(fake.subs.get("t1")!.billingAddressJson).toEqual({ country: "MX" });
  });

  it("unresolved customer → no-teacher (no crash)", async () => {
    const fake = makeFakePrisma({ subs: [] });
    const stripe = createStubStripeClient();
    const outcome = await handleBillingWebhook(
      envelope("invoice.paid", { id: "in_x", customer: "cus_unknown", status: "paid" }),
      { prisma: fake.db, stripe, priceIds: PRICE_IDS },
    );
    expect(outcome.code).toBe("no-teacher");
  });
});
