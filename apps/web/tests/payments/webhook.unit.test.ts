import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { handleStripeWebhook } from "@/lib/payments/webhook-handler";
import { createStubStripeClient } from "@/lib/stripe/stub";
import type { StripeAccount, StripeCheckoutSession, StripePaymentIntent } from "@/lib/stripe/types";

// Spy on trackServerEvent (kept real for every other export) so we can assert
// `payout_rail_connected` fires exactly on the charges_enabled false→true win.
vi.mock("@/lib/analytics/posthog", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/analytics/posthog")>()),
  trackServerEvent: vi.fn(),
}));
import { trackServerEvent } from "@/lib/analytics/posthog";
const trackServerEventMock = trackServerEvent as unknown as Mock;

// Unit test: in-memory Prisma fake + stubbed Stripe client. Real-DB
// coverage lands in a separate *.integration.test.ts that the concurrent-booking race
// integration project picks up; that test file is added when
// TEST_DATABASE_URL is wired.

type FakePayment = {
  id: string;
  externalReference: string;
  status: "pending" | "paid" | "failed" | "refunded";
  amountMinorUnits: number;
  currency: string;
  rail: "card" | "unknown";
  providerPaymentId: string | null;
  paidAt: Date | null;
  refundedAt: Date | null;
  refundProviderId: string | null;
  stripeCheckoutSessionId: string | null;
  billingCountry?: string | null;
  billingAddressJson?: Record<string, string> | null;
  package: {
    id: string;
    teacherId: string;
    studentId: string;
    templateId: string | null;
    status: "pending" | "active" | "expired" | "refunded";
  };
};

function makeFakePrisma(initial: {
  payments: FakePayment[];
  teachers: Array<{
    id: string;
    stripeAccountId: string | null;
    stripeChargesEnabled?: boolean;
  }>;
}) {
  const payments = [...initial.payments];
  const teachers = initial.teachers.map((t) => ({
    stripeChargesEnabled: false,
    ...t,
  }));
  const notifications: Array<{
    id: string;
    teacherId: string;
    templateName: string;
    paymentId: string | null;
    recipientType: string;
  }> = [];
  const teacherChargesUpdates: Array<{ id: string; charges: boolean; payouts: boolean }> = [];

  const fake = {
    payment: {
      findFirst: async (args: any) => {
        return payments.find((p) => {
          if (args.where.externalReference)
            return p.externalReference === args.where.externalReference;
          if (args.where.OR) {
            return args.where.OR.some((cond: any) => {
              if (cond.providerPaymentId) return p.providerPaymentId === cond.providerPaymentId;
              if (cond.externalReference) return p.externalReference === cond.externalReference;
              return false;
            });
          }
          if (args.where.providerPaymentId)
            return p.providerPaymentId === args.where.providerPaymentId;
          return false;
        });
      },
      update: async (args: any) => {
        const p = payments.find((x) => x.id === args.where.id);
        if (!p) throw new Error("payment not found");
        Object.assign(p, args.data);
        return p;
      },
      // Guarded flip on the pre-read status: the loser of a concurrent
      // delivery matches 0 rows.
      updateMany: async (args: any) => {
        const p = payments.find((x) => x.id === args.where.id);
        if (!p) return { count: 0 };
        if (args.where.status !== undefined && p.status !== args.where.status) {
          return { count: 0 };
        }
        Object.assign(p, args.data);
        return { count: 1 };
      },
      // Backs maybeEmitFirstPayment's post-webhook check (onboarding
      // activation audit) — this suite isn't about that signal.
      count: async () => 1,
    },
    package: {
      findUnique: async (args: any) => {
        const p = payments.find((x) => x.package.id === args.where.id);
        return p ? { ...p.package, template: { expirationMonths: null } } : null;
      },
      update: async (args: any) => {
        const p = payments.find((x) => x.package.id === args.where.id);
        if (p) Object.assign(p.package, args.data);
        return p?.package;
      },
    },
    teacher: {
      findFirst: async (args: any) => {
        return teachers.find((t) => t.stripeAccountId === args.where.stripeAccountId);
      },
      // Backs maybeEmitMarketplaceReady's post-webhook check (onboarding
      // activation audit) on the false→true charges_enabled
      // transition — this suite isn't about that signal, so null
      // short-circuits it harmlessly (see the identical maybeEmitFirstPayment
      // comment on payment.count above).
      findUnique: async () => null,
      update: async (args: any) => {
        const t = teachers.find((x) => x.id === args.where.id);
        if (t && args.data.stripeChargesEnabled !== undefined) {
          teacherChargesUpdates.push({
            id: t.id,
            charges: args.data.stripeChargesEnabled,
            payouts: args.data.stripePayoutsEnabled,
          });
          t.stripeChargesEnabled = args.data.stripeChargesEnabled;
        }
        return t;
      },
      updateMany: async (args: any) => {
        const t = teachers.find((x) => x.id === args.where.id);
        if (!t) return { count: 0 };
        // Honor the atomic conditional flip guard on the prior value.
        if (
          args.where.stripeChargesEnabled !== undefined &&
          t.stripeChargesEnabled !== args.where.stripeChargesEnabled
        ) {
          return { count: 0 };
        }
        if (args.data.stripeChargesEnabled !== undefined) {
          teacherChargesUpdates.push({
            id: t.id,
            charges: args.data.stripeChargesEnabled,
            payouts: args.data.stripePayoutsEnabled,
          });
          t.stripeChargesEnabled = args.data.stripeChargesEnabled;
        }
        return { count: 1 };
      },
    },
    notification: {
      create: async ({ data }: any) => {
        const id = `n-${notifications.length + 1}`;
        notifications.push({
          id,
          teacherId: data.teacherId,
          templateName: data.templateName,
          paymentId: data.paymentId ?? null,
          recipientType: data.recipientType,
        });
        return { id };
      },
    },
    dispute: {
      upsert: async ({ create }: any) => create,
    },
    // Slice 2b referral clawback no-op: these fixtures carry no referral.
    referral: {
      findUnique: async () => null,
    },
    $transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => fn(fake),
  };

  return { prisma: fake, payments, notifications, teacherChargesUpdates };
}

const TEACHER_ID = "11111111-1111-1111-1111-111111111111";
const STUDENT_ID = "22222222-2222-2222-2222-222222222222";
const PACKAGE_ID = "33333333-3333-3333-3333-333333333333";
const PAYMENT_ID = "44444444-4444-4444-4444-444444444444";
const EXT_REF = "55555555-5555-5555-5555-555555555555";

function freshPayment(): FakePayment {
  return {
    id: PAYMENT_ID,
    externalReference: EXT_REF,
    status: "pending",
    amountMinorUnits: 150_000,
    currency: "MXN",
    rail: "unknown",
    providerPaymentId: null,
    paidAt: null,
    refundedAt: null,
    refundProviderId: null,
    stripeCheckoutSessionId: null,
    package: {
      id: PACKAGE_ID,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      templateId: null,
      status: "pending",
    },
  };
}

describe("handleStripeWebhook", () => {
  let stripe: ReturnType<typeof createStubStripeClient>;

  beforeEach(() => {
    stripe = createStubStripeClient();
    trackServerEventMock.mockClear();
  });

  it("ignores unhandled event types", async () => {
    const env = makeFakePrisma({ payments: [freshPayment()], teachers: [] });
    const result = await handleStripeWebhook(
      { id: "evt_1", type: "ping", data: { object: {} } },
      { prisma: env.prisma as any, stripe },
    );
    expect(result.code).toBe("ignored-unhandled-type");
  });

  it("checkout.session.completed (payment mode) flips Payment to paid + activates Package + queues student and teacher notifications", async () => {
    const env = makeFakePrisma({ payments: [freshPayment()], teachers: [] });
    const session: StripeCheckoutSession = {
      id: "cs_TEST_1",
      status: "complete",
      payment_status: "paid",
      mode: "payment",
      url: null,
      client_reference_id: EXT_REF,
      payment_intent: "pi_TEST_1",
      customer: null,
      metadata: null,
      amount_total: 150_000,
      currency: "mxn",
    };
    const intent: StripePaymentIntent = {
      id: "pi_TEST_1",
      status: "succeeded",
      amount: 150_000,
      amount_received: 150_000,
      currency: "mxn",
      payment_method_types: ["card"],
      payment_method: "pm_TEST",
      charges: { data: [{ id: "ch_TEST", payment_method_details: { type: "card" } }] },
    };
    stripe.seedCheckoutSession(session);
    stripe.seedPaymentIntent(intent);

    const result = await handleStripeWebhook(
      { id: "evt_2", type: "checkout.session.completed", data: { object: session } },
      { prisma: env.prisma as any, stripe },
    );
    expect(result.code).toBe("applied");
    if (result.code !== "applied") throw new Error();
    expect(result.action).toBe("flip-paid");
    expect(env.payments[0].status).toBe("paid");
    expect(env.payments[0].providerPaymentId).toBe("pi_TEST_1");
    expect(env.payments[0].rail).toBe("card");
    expect(env.payments[0].package.status).toBe("active");
    expect(env.notifications.length).toBe(2);
    expect(env.notifications.map((n) => n.templateName).sort()).toEqual([
      "payment_received",
      "payment_received_teacher",
    ]);
  });

  it("noops the losing concurrent delivery (guarded flip matched 0 rows) without double side effects", async () => {
    // Regression: checkout.session.completed and payment_intent.succeeded race.
    // Both read status='pending' (so advancePayment computes flip-paid for
    // both), but the guarded updateMany lets only ONE win. Simulate the loser:
    // its updateMany matches 0 rows because the winner already flipped the row.
    // It must NOT re-activate the package or re-enqueue the notification set.
    const pending = freshPayment();
    const env = makeFakePrisma({ payments: [pending], teachers: [] });
    env.prisma.payment.updateMany = async () => ({ count: 0 });
    const intent: StripePaymentIntent = {
      id: "pi_TEST_1",
      status: "succeeded",
      amount: 150_000,
      amount_received: 150_000,
      currency: "mxn",
      payment_method_types: ["card"],
      payment_method: "pm_TEST",
      // Resolves the pending payment row by our external_reference.
      metadata: { external_reference: EXT_REF },
      charges: { data: [{ id: "ch_TEST", payment_method_details: { type: "card" } }] },
    };
    stripe.seedPaymentIntent(intent);

    const result = await handleStripeWebhook(
      { id: "evt_race", type: "payment_intent.succeeded", data: { object: intent } },
      { prisma: env.prisma as any, stripe },
    );

    expect(result).toEqual({ code: "noop", reason: "already-transitioned" });
    // The loser enqueued nothing and did not activate the package.
    expect(env.notifications).toHaveLength(0);
    expect(env.payments[0].package.status).not.toBe("active");
  });

  it("checkout.session.completed persists the captured billing country + address (VAT/GST readiness)", async () => {
    const env = makeFakePrisma({ payments: [freshPayment()], teachers: [] });
    const session: StripeCheckoutSession = {
      id: "cs_BILL",
      status: "complete",
      payment_status: "paid",
      mode: "payment",
      url: null,
      client_reference_id: EXT_REF,
      payment_intent: "pi_BILL",
      customer: null,
      metadata: null,
      amount_total: 150_000,
      currency: "mxn",
      // Collected on the hosted page via billing_address_collection=required.
      customer_details: {
        address: {
          line1: "221B Baker St",
          line2: "",
          city: "London",
          postal_code: "NW1 6XE",
          country: "GB",
        },
        email: "student@example.com",
        name: "Student",
      },
    };
    const intent: StripePaymentIntent = {
      id: "pi_BILL",
      status: "succeeded",
      amount: 150_000,
      amount_received: 150_000,
      currency: "mxn",
      payment_method_types: ["card"],
      payment_method: "pm_TEST",
      charges: { data: [{ id: "ch_TEST", payment_method_details: { type: "card" } }] },
    };
    stripe.seedCheckoutSession(session);
    stripe.seedPaymentIntent(intent);

    const result = await handleStripeWebhook(
      { id: "evt_bill", type: "checkout.session.completed", data: { object: session } },
      { prisma: env.prisma as any, stripe },
    );
    expect(result.code).toBe("applied");
    // Country + full address persisted; blank line2 dropped.
    expect(env.payments[0].billingCountry).toBe("GB");
    expect(env.payments[0].billingAddressJson).toEqual({
      line1: "221B Baker St",
      city: "London",
      postal_code: "NW1 6XE",
      country: "GB",
    });
  });

  it("checkout.session.completed with no collected address leaves billing fields untouched", async () => {
    const env = makeFakePrisma({ payments: [freshPayment()], teachers: [] });
    const session: StripeCheckoutSession = {
      id: "cs_NOBILL",
      status: "complete",
      payment_status: "paid",
      mode: "payment",
      url: null,
      client_reference_id: EXT_REF,
      payment_intent: "pi_NOBILL",
      customer: null,
      metadata: null,
      amount_total: 150_000,
      currency: "mxn",
    };
    stripe.seedCheckoutSession(session);
    stripe.seedPaymentIntent({
      id: "pi_NOBILL",
      status: "succeeded",
      amount: 150_000,
      amount_received: 150_000,
      currency: "mxn",
      payment_method_types: ["card"],
      payment_method: "pm_TEST",
      charges: { data: [{ id: "ch", payment_method_details: { type: "card" } }] },
    });
    await handleStripeWebhook(
      { id: "evt_nobill", type: "checkout.session.completed", data: { object: session } },
      { prisma: env.prisma as any, stripe },
    );
    expect(env.payments[0].billingCountry).toBeUndefined();
    expect(env.payments[0].billingAddressJson).toBeUndefined();
  });

  it("checkout.session.completed (unpaid) records the session id but stays pending", async () => {
    const env = makeFakePrisma({ payments: [freshPayment()], teachers: [] });
    const session: StripeCheckoutSession = {
      id: "cs_TEST_2",
      status: "open",
      payment_status: "unpaid",
      mode: "payment",
      url: null,
      client_reference_id: EXT_REF,
      payment_intent: null,
      customer: null,
      metadata: null,
      amount_total: 150_000,
      currency: "mxn",
    };
    stripe.seedCheckoutSession(session);
    const result = await handleStripeWebhook(
      { id: "evt_3", type: "checkout.session.completed", data: { object: session } },
      { prisma: env.prisma as any, stripe },
    );
    expect(result.code).toBe("noop");
    expect(env.payments[0].status).toBe("pending");
    expect(env.payments[0].stripeCheckoutSessionId).toBe("cs_TEST_2");
  });

  it("payment_intent.payment_failed flips pending Payment to failed + queues payment_failed_student", async () => {
    const env = makeFakePrisma({ payments: [freshPayment()], teachers: [] });
    const intent: StripePaymentIntent = {
      id: "pi_TEST_FAIL",
      status: "canceled",
      amount: 150_000,
      currency: "mxn",
      payment_method_types: ["card"],
      payment_method: null,
      charges: { data: [] },
      metadata: { external_reference: EXT_REF },
    };
    stripe.seedPaymentIntent(intent);

    const result = await handleStripeWebhook(
      { id: "evt_4", type: "payment_intent.payment_failed", data: { object: intent } },
      { prisma: env.prisma as any, stripe },
    );
    expect(result.code).toBe("applied");
    if (result.code !== "applied") throw new Error();
    expect(result.action).toBe("flip-failed");
    expect(env.payments[0].status).toBe("failed");
    expect(env.notifications).toHaveLength(1);
    expect(env.notifications[0]).toMatchObject({
      templateName: "payment_failed_student",
      recipientType: "student",
      paymentId: PAYMENT_ID,
    });
  });

  it("charge.refunded on a paid Payment flips it to refunded + queues refund_issued_student + refund_issued_teacher", async () => {
    const paid = freshPayment();
    paid.status = "paid";
    paid.providerPaymentId = "pi_TEST_PAID";
    paid.paidAt = new Date();
    paid.package.status = "active";
    const env = makeFakePrisma({ payments: [paid], teachers: [] });

    const result = await handleStripeWebhook(
      {
        id: "evt_5",
        type: "charge.refunded",
        data: { object: { payment_intent: "pi_TEST_PAID" } },
      },
      { prisma: env.prisma as any, stripe },
    );
    expect(result.code).toBe("applied");
    if (result.code !== "applied") throw new Error();
    expect(result.action).toBe("flip-refunded");
    expect(env.payments[0].status).toBe("refunded");
    expect(env.payments[0].package.status).toBe("refunded");
    expect(env.notifications).toHaveLength(2);
    expect(env.notifications.map((n) => n.templateName).sort()).toEqual([
      "refund_issued_student",
      "refund_issued_teacher",
    ]);
    const teacherNotif = env.notifications.find((n) => n.templateName === "refund_issued_teacher");
    expect(teacherNotif?.recipientType).toBe("teacher");
  });

  it("charge.refunded with refunded=false (partial dashboard refund) is a noop — does NOT revoke the package", async () => {
    const paid = freshPayment();
    paid.status = "paid";
    paid.providerPaymentId = "pi_TEST_PAID";
    paid.paidAt = new Date();
    paid.package.status = "active";
    const env = makeFakePrisma({ payments: [paid], teachers: [] });

    const result = await handleStripeWebhook(
      {
        id: "evt_5b",
        type: "charge.refunded",
        data: { object: { payment_intent: "pi_TEST_PAID", refunded: false, amount_refunded: 1 } },
      },
      { prisma: env.prisma as any, stripe },
    );
    expect(result.code).toBe("noop");
    // Payment + package untouched; no refund notifications fired.
    expect(env.payments[0].status).toBe("paid");
    expect(env.payments[0].package.status).toBe("active");
    expect(env.notifications).toHaveLength(0);
  });

  it("account.updated false→true mirrors state + queues stripe_ready_teacher", async () => {
    const account: StripeAccount = {
      id: "acct_TEST_1",
      charges_enabled: true,
      payouts_enabled: true,
    };
    stripe.seedAccount(account);
    const env = makeFakePrisma({
      payments: [freshPayment()],
      teachers: [{ id: TEACHER_ID, stripeAccountId: "acct_TEST_1", stripeChargesEnabled: false }],
    });
    const result = await handleStripeWebhook(
      { id: "evt_6", type: "account.updated", data: { object: account } },
      { prisma: env.prisma as any, stripe },
    );
    expect(result.code).toBe("applied-account-updated");
    expect(env.teacherChargesUpdates).toHaveLength(1);
    expect(env.teacherChargesUpdates[0]).toEqual({
      id: TEACHER_ID,
      charges: true,
      payouts: true,
    });
    expect(env.notifications).toHaveLength(1);
    expect(env.notifications[0]).toMatchObject({
      templateName: "stripe_ready_teacher",
      recipientType: "teacher",
      teacherId: TEACHER_ID,
    });
    // Teacher just became payout-ready → the Stripe rail connect fires once.
    expect(trackServerEventMock).toHaveBeenCalledWith({
      name: "payout_rail_connected",
      distinctId: TEACHER_ID,
      properties: { teacherId: TEACHER_ID, rail: "stripe" },
    });
  });

  it("account.updated true→false queues stripe_requirements_teacher", async () => {
    const account: StripeAccount = {
      id: "acct_TEST_2",
      charges_enabled: false,
      payouts_enabled: true,
    };
    stripe.seedAccount(account);
    const env = makeFakePrisma({
      payments: [freshPayment()],
      teachers: [{ id: TEACHER_ID, stripeAccountId: "acct_TEST_2", stripeChargesEnabled: true }],
    });
    const result = await handleStripeWebhook(
      { id: "evt_6b", type: "account.updated", data: { object: account } },
      { prisma: env.prisma as any, stripe },
    );
    expect(result.code).toBe("applied-account-updated");
    expect(env.notifications).toHaveLength(1);
    expect(env.notifications[0].templateName).toBe("stripe_requirements_teacher");
    // Losing the rail is not "connected" — no payout_rail_connected here.
    expect(trackServerEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "payout_rail_connected" }),
    );
  });

  it("account.updated with no transition (true→true) doesn't queue a notification", async () => {
    const account: StripeAccount = {
      id: "acct_TEST_3",
      charges_enabled: true,
      payouts_enabled: true,
    };
    stripe.seedAccount(account);
    const env = makeFakePrisma({
      payments: [freshPayment()],
      teachers: [{ id: TEACHER_ID, stripeAccountId: "acct_TEST_3", stripeChargesEnabled: true }],
    });
    await handleStripeWebhook(
      { id: "evt_6c", type: "account.updated", data: { object: account } },
      { prisma: env.prisma as any, stripe },
    );
    expect(env.notifications).toHaveLength(0);
    // No transition → no payout_rail_connected re-fire.
    expect(trackServerEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "payout_rail_connected" }),
    );
  });

  it("subscription / invoice events fall through to the subscription handler (ignored here)", async () => {
    const env = makeFakePrisma({ payments: [], teachers: [] });
    const result = await handleStripeWebhook(
      { id: "evt_7", type: "customer.subscription.created", data: { object: {} } },
      { prisma: env.prisma as any, stripe },
    );
    expect(result.code).toBe("ignored-unhandled-type");
  });

  // docs/security.md.
  it("charge.dispute.created upserts a dispute row and matches the payment", async () => {
    const paid = freshPayment();
    paid.providerPaymentId = "pi_TEST_1";
    paid.status = "paid";
    const env = makeFakePrisma({ payments: [paid], teachers: [] });
    const upserts: Array<{ create: any; update: any; where: any }> = [];
    env.prisma.dispute = {
      upsert: async ({ create, update, where }: any) => {
        upserts.push({ create, update, where });
        return create;
      },
    } as any;

    const result = await handleStripeWebhook(
      {
        id: "evt_dp_1",
        type: "charge.dispute.created",
        data: {
          object: {
            id: "dp_TEST_1",
            charge: "ch_TEST_1",
            payment_intent: "pi_TEST_1",
            amount: 150_000,
            currency: "mxn",
            reason: "fraudulent",
            status: "needs_response",
            evidence_details: { due_by: 1717200000 },
            is_charge_refundable: true,
          },
        },
      },
      { prisma: env.prisma as any, stripe },
    );

    expect(result.code).toBe("applied-dispute");
    if (result.code !== "applied-dispute") throw new Error();
    expect(result.paymentId).toBe(PAYMENT_ID);
    expect(result.status).toBe("needs_response");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].create.stripeDisputeId).toBe("dp_TEST_1");
    expect(upserts[0].create.teacherId).toBe(TEACHER_ID);
    expect(upserts[0].create.isFinal).toBe(false);
  });

  it("charge.dispute.closed marks isFinal=true even without a payment match", async () => {
    const env = makeFakePrisma({ payments: [], teachers: [] });
    const upserts: any[] = [];
    env.prisma.dispute = {
      upsert: async (args: any) => {
        upserts.push(args.create);
        return args.create;
      },
    } as any;

    const result = await handleStripeWebhook(
      {
        id: "evt_dp_2",
        type: "charge.dispute.closed",
        data: {
          object: {
            id: "dp_TEST_2",
            charge: "ch_TEST_2",
            payment_intent: null,
            amount: 50_000,
            currency: "mxn",
            reason: "duplicate",
            status: "lost",
            is_charge_refundable: false,
          },
        },
      },
      { prisma: env.prisma as any, stripe },
    );

    expect(result.code).toBe("applied-dispute");
    if (result.code !== "applied-dispute") throw new Error();
    expect(result.paymentId).toBeNull();
    expect(result.action).toBe("skip-unmatched");
    expect(upserts[0].isFinal).toBe(true);
  });

  // A lost dispute takes the money out of the TEACHER's balance (she is the
  // merchant of record under direct charges) and revokes the student's
  // remaining classes. It used to do both in silence — the student's package
  // simply became "Reembolsado", and the teacher had only a Sentry alert
  // routed to ops rather than to her.
  it("charge.dispute.updated (lost) revokes the credits AND tells both sides", async () => {
    const paid = freshPayment();
    paid.providerPaymentId = "pi_TEST_1";
    paid.status = "paid";
    const env = makeFakePrisma({ payments: [paid], teachers: [] });

    const result = await handleStripeWebhook(
      {
        id: "evt_dp_lost_1",
        type: "charge.dispute.updated",
        data: {
          object: {
            id: "dp_TEST_LOST",
            charge: "ch_TEST_1",
            payment_intent: "pi_TEST_1",
            amount: 150_000,
            currency: "mxn",
            reason: "fraudulent",
            status: "lost",
            is_charge_refundable: false,
          },
        },
      },
      { prisma: env.prisma as any, stripe },
    );

    expect(result.code).toBe("applied-dispute");
    expect(paid.status).toBe("refunded");
    expect(paid.package.status).toBe("refunded");

    expect(env.notifications.map((n) => n.templateName).sort()).toEqual([
      "dispute_lost_student",
      "dispute_lost_teacher",
    ]);
    // Addressed to the real people, not merely created.
    expect(env.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          templateName: "dispute_lost_student",
          recipientType: "student",
          paymentId: PAYMENT_ID,
        }),
        expect.objectContaining({
          templateName: "dispute_lost_teacher",
          recipientType: "teacher",
          paymentId: PAYMENT_ID,
        }),
      ]),
    );
    // NOT the refund copy: nothing was refunded, and saying so would be wrong
    // about what happened to her money and to her classes.
    expect(env.notifications.map((n) => n.templateName)).not.toContain("refund_issued_student");
  });

  it("a redelivered lost dispute does not re-revoke or re-notify", async () => {
    const paid = freshPayment();
    paid.providerPaymentId = "pi_TEST_1";
    // Already terminal from the first delivery.
    paid.status = "refunded";
    const env = makeFakePrisma({ payments: [paid], teachers: [] });

    await handleStripeWebhook(
      {
        id: "evt_dp_lost_2",
        type: "charge.dispute.updated",
        data: {
          object: {
            id: "dp_TEST_LOST",
            charge: "ch_TEST_1",
            payment_intent: "pi_TEST_1",
            amount: 150_000,
            currency: "mxn",
            reason: "fraudulent",
            status: "lost",
            is_charge_refundable: false,
          },
        },
      },
      { prisma: env.prisma as any, stripe },
    );

    expect(env.notifications).toHaveLength(0);
  });

  it("a lost dispute on an unmatched charge notifies nobody", async () => {
    // No payment row to tie it back to, so there is no student or teacher to
    // address. The dispute row is still recorded for ops (asserted above).
    const env = makeFakePrisma({ payments: [], teachers: [] });

    await handleStripeWebhook(
      {
        id: "evt_dp_lost_3",
        type: "charge.dispute.updated",
        data: {
          object: {
            id: "dp_TEST_ORPHAN",
            charge: "ch_UNKNOWN",
            payment_intent: "pi_UNKNOWN",
            amount: 150_000,
            currency: "mxn",
            reason: "fraudulent",
            status: "lost",
            is_charge_refundable: false,
          },
        },
      },
      { prisma: env.prisma as any, stripe },
    );

    expect(env.notifications).toHaveLength(0);
  });

  // ---------- async payment methods (Stripe bank transfer, OXXO) ----------
  //
  // These leave `checkout.session.completed` with payment_status 'unpaid' and
  // resolve hours or days later. Stripe has been sending both events on the
  // Connect destination since D-143 and NEITHER was handled — they fell to
  // ignored-unhandled-type. Success was covered by luck, because
  // payment_intent.succeeded also fires. Failure was not covered at all, which
  // is why production holds Stripe payments that are still `pending` with no
  // PaymentIntent and packages that expired without ever being paid for.

  it("async_payment_succeeded flips the row the unpaid session left pending", async () => {
    const env = makeFakePrisma({ payments: [freshPayment()], teachers: [] });
    const session: StripeCheckoutSession = {
      id: "cs_ASYNC_OK",
      status: "complete",
      // The session is re-fetched, and by now the transfer has landed.
      payment_status: "paid",
      mode: "payment",
      url: null,
      client_reference_id: EXT_REF,
      payment_intent: "pi_ASYNC_OK",
      customer: null,
      metadata: null,
      amount_total: 150_000,
      currency: "mxn",
    };
    stripe.seedCheckoutSession(session);
    stripe.seedPaymentIntent({
      id: "pi_ASYNC_OK",
      status: "succeeded",
      amount: 150_000,
      amount_received: 150_000,
      currency: "mxn",
      payment_method_types: ["customer_balance"],
      payment_method: "pm_ASYNC",
      charges: { data: [{ id: "ch_ASYNC", payment_method_details: { type: "customer_balance" } }] },
    });

    const result = await handleStripeWebhook(
      {
        id: "evt_async_ok",
        type: "checkout.session.async_payment_succeeded",
        data: { object: session },
      },
      { prisma: env.prisma as any, stripe },
    );

    expect(result.code).toBe("applied");
    expect(env.payments[0].status).toBe("paid");
    expect(env.payments[0].package.status).toBe("active");
  });

  it("async_payment_failed marks the payment failed instead of leaving it pending for ever", async () => {
    const env = makeFakePrisma({ payments: [freshPayment()], teachers: [] });
    const session: StripeCheckoutSession = {
      id: "cs_ASYNC_BAD",
      status: "complete",
      payment_status: "unpaid",
      mode: "payment",
      url: null,
      client_reference_id: EXT_REF,
      payment_intent: "pi_ASYNC_BAD",
      customer: null,
      metadata: null,
      amount_total: 150_000,
      currency: "mxn",
    };
    stripe.seedCheckoutSession(session);
    stripe.seedPaymentIntent({
      id: "pi_ASYNC_BAD",
      status: "requires_payment_method",
      amount: 150_000,
      amount_received: 0,
      currency: "mxn",
      payment_method_types: ["customer_balance"],
      payment_method: null,
      charges: { data: [] },
    });

    const result = await handleStripeWebhook(
      {
        id: "evt_async_bad",
        type: "checkout.session.async_payment_failed",
        data: { object: session },
      },
      { prisma: env.prisma as any, stripe },
    );

    expect(result.code).toBe("applied");
    expect(env.payments[0].status).toBe("failed");
    // The package must NOT be left looking purchasable-but-unpaid.
    expect(env.payments[0].package.status).not.toBe("active");
  });

  // ---------- checkout.session.expired ----------
  //
  // The buyer opened checkout and never paid. There is usually no
  // PaymentIntent, so no payment_intent.* event ever fires and this is the only
  // report of the outcome. Four production rows sat `pending` for exactly this
  // reason, one of them for MX$1,300.

  it("expired session flips the abandoned payment to failed", async () => {
    const env = makeFakePrisma({ payments: [freshPayment()], teachers: [] });
    const session: StripeCheckoutSession = {
      id: "cs_EXPIRED",
      status: "expired",
      payment_status: "unpaid",
      mode: "payment",
      url: null,
      client_reference_id: EXT_REF,
      // The realistic shape: expired before Stripe ever attached an intent.
      payment_intent: null,
      customer: null,
      metadata: null,
      amount_total: 150_000,
      currency: "mxn",
    };
    stripe.seedCheckoutSession(session);

    const result = await handleStripeWebhook(
      { id: "evt_exp", type: "checkout.session.expired", data: { object: session } },
      { prisma: env.prisma as any, stripe },
    );

    expect(result.code).toBe("applied");
    expect(env.payments[0].status).toBe("failed");
    expect(env.payments[0].package.status).not.toBe("active");
  });

  it("a session that expires AFTER being paid is not treated as a failure", async () => {
    // Stripe can expire a session that already completed. The money arrived;
    // this event says nothing about it, and must not undo a paid row.
    const paid = freshPayment();
    paid.status = "paid";
    paid.package.status = "active";
    const env = makeFakePrisma({ payments: [paid], teachers: [] });
    const session: StripeCheckoutSession = {
      id: "cs_EXPIRED_PAID",
      status: "expired",
      payment_status: "paid",
      mode: "payment",
      url: null,
      client_reference_id: EXT_REF,
      payment_intent: "pi_PAID",
      customer: null,
      metadata: null,
      amount_total: 150_000,
      currency: "mxn",
    };
    stripe.seedCheckoutSession(session);

    const result = await handleStripeWebhook(
      { id: "evt_exp_paid", type: "checkout.session.expired", data: { object: session } },
      { prisma: env.prisma as any, stripe },
    );

    expect(result.code).toBe("noop");
    if (result.code !== "noop") throw new Error();
    expect(result.reason).toBe("expired-after-paid");
    expect(env.payments[0].status).toBe("paid");
    expect(env.payments[0].package.status).toBe("active");
  });

  it("a failed session with no PaymentIntent has nothing to reconcile", async () => {
    const env = makeFakePrisma({ payments: [freshPayment()], teachers: [] });
    const session: StripeCheckoutSession = {
      id: "cs_ASYNC_NOPI",
      status: "expired",
      payment_status: "unpaid",
      mode: "payment",
      url: null,
      client_reference_id: EXT_REF,
      payment_intent: null,
      customer: null,
      metadata: null,
      amount_total: 150_000,
      currency: "mxn",
    };
    stripe.seedCheckoutSession(session);

    const result = await handleStripeWebhook(
      {
        id: "evt_async_nopi",
        type: "checkout.session.async_payment_failed",
        data: { object: session },
      },
      { prisma: env.prisma as any, stripe },
    );

    expect(result.code).toBe("noop");
    if (result.code !== "noop") throw new Error();
    expect(result.reason).toBe("async-failed-without-payment-intent");
    // Untouched — there was never a charge.
    expect(env.payments[0].status).toBe("pending");
  });
});
