import { beforeEach, expect, it } from "vitest";
import { handleStripeWebhook } from "@/lib/payments/webhook-handler";
import { createStubStripeClient } from "@/lib/stripe/stub";
import type { StripeAccount, StripeCheckoutSession, StripePaymentIntent } from "@/lib/stripe/types";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";

// Real-DB port of tests/payments/webhook.unit.test.ts. The unit suite
// exercises every branch against an in-memory Prisma fake; this run
// hits a real Postgres so the cross-table updates (payment + package
// + notification, dispute upsert, teacher mirror) trip on actual SQL
// + FKs + the tenant isolation join filters.
//
// Asserts that the unit fake can't:
//   - applyTransition's single $transaction lands every write or none
//     (we observe Payment.status, Package.status, and the queued
//     Notification rows from the same connection)
//   - payment row is resolved by `external_reference` via the real
//     unique index, not by an in-mem filter
//   - the dispute upsert collapses a `created` → `updated` pair onto
//     one row keyed by stripe_dispute_id
//   - account.updated flips `stripe_charges_enabled` on the live
//     teacher row + correctly detects the false→true transition
//   - replaying payment_intent.succeeded after the Payment is already
//     paid is a clean noop — no double package activation, no
//     duplicate notification rows

const TEACHER_ID = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const STUDENT_EMAIL = "alumno-pay@e2e.test";

async function ensureAuthUser(id: string, email: string) {
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    id,
    email,
  );
}

type SeedResult = {
  teacherId: string;
  studentId: string;
  packageId: string;
  paymentId: string;
  externalReference: string;
};

async function seedPendingPayment(
  opts: {
    stripeAccountId?: string | null;
    stripeChargesEnabled?: boolean;
    paymentStatus?: "pending" | "paid";
    packageStatus?: "pending" | "active";
    providerPaymentId?: string | null;
  } = {},
): Promise<SeedResult> {
  const prisma = getTestPrisma();
  await ensureAuthUser(TEACHER_ID, "teacher-pay@e2e.test");
  const teacher = await prisma.teacher.create({
    data: {
      id: TEACHER_ID,
      email: "teacher-pay@e2e.test",
      name: "Alicia Moreno",
      timezone: "America/Mexico_City",
      bookingSlug: "teacher-pay",
      stripeAccountId: opts.stripeAccountId ?? null,
      stripeChargesEnabled: opts.stripeChargesEnabled ?? false,
    },
    select: { id: true },
  });
  const student = await prisma.student.create({
    data: { email: STUDENT_EMAIL, name: "Alumno", locale: "es-MX" },
    select: { id: true },
  });
  await prisma.teacherStudent.create({
    data: { teacherId: teacher.id, studentId: student.id },
  });
  const pkg = await prisma.package.create({
    data: {
      teacherId: teacher.id,
      studentId: student.id,
      classesTotal: 10,
      classesUsed: 0,
      classDurationMin: 50,
      pricePaidMinorUnits: 150_000,
      purchasedAt: new Date(),
      status: opts.packageStatus ?? "pending",
    },
    select: { id: true },
  });
  const payment = await prisma.payment.create({
    data: {
      packageId: pkg.id,
      amountMinorUnits: 150_000,
      status: opts.paymentStatus ?? "pending",
      provider: "stripe",
      providerPaymentId: opts.providerPaymentId ?? null,
      paidAt: opts.paymentStatus === "paid" ? new Date() : null,
    },
    select: { id: true, externalReference: true },
  });
  return {
    teacherId: teacher.id,
    studentId: student.id,
    packageId: pkg.id,
    paymentId: payment.id,
    externalReference: payment.externalReference,
  };
}

describeIntegration("handleStripeWebhook (real DB)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("defaults Package and Payment currency to MXN when not set explicitly", async () => {
    const seeded = await seedPendingPayment();
    const prisma = getTestPrisma();
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: seeded.packageId } });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: seeded.paymentId } });
    expect(pkg.currency).toBe("MXN");
    expect(payment.currency).toBe("MXN");
  });

  it("checkout.session.completed (paid) flips Payment+Package and queues payment_received in a single tx", async () => {
    const seeded = await seedPendingPayment();
    const stripe = createStubStripeClient();
    const session: StripeCheckoutSession = {
      id: "cs_IT_1",
      status: "complete",
      payment_status: "paid",
      mode: "payment",
      url: null,
      client_reference_id: seeded.externalReference,
      payment_intent: "pi_IT_1",
      customer: null,
      metadata: null,
      amount_total: 150_000,
      currency: "mxn",
    };
    const intent: StripePaymentIntent = {
      id: "pi_IT_1",
      status: "succeeded",
      amount: 150_000,
      amount_received: 150_000,
      currency: "mxn",
      payment_method_types: ["card"],
      payment_method: "pm_IT_1",
      charges: { data: [{ id: "ch_IT_1", payment_method_details: { type: "card" } }] },
    };
    stripe.seedCheckoutSession(session);
    stripe.seedPaymentIntent(intent);

    const events: Array<{ name: string }> = [];
    const result = await handleStripeWebhook(
      { id: "evt_IT_1", type: "checkout.session.completed", data: { object: session } },
      {
        prisma: getTestPrisma(),
        stripe,
        emit: async (e) => {
          events.push({ name: e.name });
        },
      },
    );
    expect(result.code).toBe("applied");
    if (result.code !== "applied") throw new Error();
    expect(result.action).toBe("flip-paid");

    const prisma = getTestPrisma();
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: seeded.paymentId },
    });
    expect(payment.status).toBe("paid");
    expect(payment.providerPaymentId).toBe("pi_IT_1");
    expect(payment.rail).toBe("card");
    expect(payment.paidAt).toBeInstanceOf(Date);
    expect(payment.stripeCheckoutSessionId).toBe("cs_IT_1");

    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: seeded.packageId } });
    expect(pkg.status).toBe("active");

    const notifs = await prisma.notification.findMany({
      where: { paymentId: seeded.paymentId },
      orderBy: { templateName: "asc" },
    });
    // Student receipt + teacher sale notice (review item 7), same tx.
    expect(notifs).toHaveLength(2);
    expect(notifs[0]?.templateName).toBe("payment_received");
    expect(notifs[0]?.recipientType).toBe("student");
    expect(notifs[0]?.status).toBe("queued");
    expect(notifs[1]?.templateName).toBe("payment_received_teacher");
    expect(notifs[1]?.recipientType).toBe("teacher");
    expect(notifs[1]?.status).toBe("queued");

    // Two notification.queued + one payment.paid Inngest event.
    expect(events.map((e) => e.name).sort()).toEqual([
      "notification.queued",
      "notification.queued",
      "payment.paid",
    ]);
  });

  it("replay of payment_intent.succeeded on an already-paid Payment is a noop: no duplicate notifications, no second package activation", async () => {
    const seeded = await seedPendingPayment({
      paymentStatus: "paid",
      packageStatus: "active",
      providerPaymentId: "pi_IT_REPLAY",
    });
    const stripe = createStubStripeClient();
    const intent: StripePaymentIntent = {
      id: "pi_IT_REPLAY",
      status: "succeeded",
      amount: 150_000,
      amount_received: 150_000,
      currency: "mxn",
      payment_method_types: ["card"],
      payment_method: "pm_IT_REPLAY",
      charges: { data: [{ id: "ch_IT_REPLAY", payment_method_details: { type: "card" } }] },
      metadata: { external_reference: seeded.externalReference },
    };
    stripe.seedPaymentIntent(intent);

    const result = await handleStripeWebhook(
      { id: "evt_IT_REPLAY", type: "payment_intent.succeeded", data: { object: intent } },
      { prisma: getTestPrisma(), stripe },
    );
    expect(result.code).toBe("noop");

    const prisma = getTestPrisma();
    const notifs = await prisma.notification.findMany({
      where: { paymentId: seeded.paymentId },
    });
    expect(notifs).toHaveLength(0); // none added on replay
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: seeded.packageId } });
    expect(pkg.status).toBe("active");
  });

  it("charge.refunded on a paid Payment flips Payment+Package to refunded + queues both refund notifications", async () => {
    const seeded = await seedPendingPayment({
      paymentStatus: "paid",
      packageStatus: "active",
      providerPaymentId: "pi_IT_REFUND",
    });
    const stripe = createStubStripeClient();

    const result = await handleStripeWebhook(
      {
        id: "evt_IT_REFUND",
        type: "charge.refunded",
        data: { object: { payment_intent: "pi_IT_REFUND" } },
      },
      { prisma: getTestPrisma(), stripe },
    );
    expect(result.code).toBe("applied");
    if (result.code !== "applied") throw new Error();
    expect(result.action).toBe("flip-refunded");

    const prisma = getTestPrisma();
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: seeded.paymentId },
    });
    expect(payment.status).toBe("refunded");
    expect(payment.refundedAt).toBeInstanceOf(Date);

    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: seeded.packageId } });
    expect(pkg.status).toBe("refunded");

    const notifs = await prisma.notification.findMany({
      where: { paymentId: seeded.paymentId },
      orderBy: { templateName: "asc" },
    });
    expect(notifs.map((n) => n.templateName)).toEqual([
      "refund_issued_student",
      "refund_issued_teacher",
    ]);
  });

  it("charge.dispute.created then .updated collapses to one row keyed by stripe_dispute_id", async () => {
    const seeded = await seedPendingPayment({
      paymentStatus: "paid",
      packageStatus: "active",
      providerPaymentId: "pi_IT_DISPUTE",
    });
    const stripe = createStubStripeClient();
    const prisma = getTestPrisma();

    const baseDispute = {
      id: "dp_IT_1",
      charge: "ch_IT_DISPUTE",
      payment_intent: "pi_IT_DISPUTE",
      amount: 150_000,
      currency: "mxn",
      reason: "fraudulent",
      is_charge_refundable: true,
    };

    const created = await handleStripeWebhook(
      {
        id: "evt_IT_DP_1",
        type: "charge.dispute.created",
        data: { object: { ...baseDispute, status: "needs_response" } },
      },
      { prisma, stripe },
    );
    expect(created.code).toBe("applied-dispute");

    const updated = await handleStripeWebhook(
      {
        id: "evt_IT_DP_2",
        type: "charge.dispute.updated",
        data: {
          object: {
            ...baseDispute,
            status: "under_review",
            evidence_details: { due_by: 1_900_000_000 },
          },
        },
      },
      { prisma, stripe },
    );
    expect(updated.code).toBe("applied-dispute");

    const rows = await prisma.dispute.findMany({ where: { stripeDisputeId: "dp_IT_1" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("under_review");
    expect(rows[0]?.paymentId).toBe(seeded.paymentId);
    expect(rows[0]?.teacherId).toBe(seeded.teacherId);
    expect(rows[0]?.evidenceDueBy).toEqual(new Date(1_900_000_000 * 1000));
  });

  it("account.updated false→true mirrors charges_enabled onto the teacher row and queues stripe_ready_teacher", async () => {
    await seedPendingPayment({
      stripeAccountId: "acct_IT_1",
      stripeChargesEnabled: false,
    });
    const account: StripeAccount = {
      id: "acct_IT_1",
      charges_enabled: true,
      payouts_enabled: true,
    };
    const stripe = createStubStripeClient();
    stripe.seedAccount(account);
    const prisma = getTestPrisma();

    const result = await handleStripeWebhook(
      { id: "evt_IT_ACCT", type: "account.updated", data: { object: account } },
      { prisma, stripe },
    );
    expect(result.code).toBe("applied-account-updated");

    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: TEACHER_ID } });
    expect(teacher.stripeChargesEnabled).toBe(true);
    expect(teacher.stripePayoutsEnabled).toBe(true);

    const notifs = await prisma.notification.findMany({
      where: { teacherId: TEACHER_ID, templateName: "stripe_ready_teacher" },
    });
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.recipientType).toBe("teacher");
    expect(notifs[0]?.status).toBe("queued");
  });
});
