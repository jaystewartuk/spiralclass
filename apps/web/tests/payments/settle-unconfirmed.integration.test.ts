import { beforeEach, expect, it } from "vitest";
import { handleStripeWebhook } from "@/lib/payments/webhook-handler";
import { cleanupAbandonedPendingPackages } from "@/lib/payments/cleanup-pending";
import {
  askStripeAboutPendingPayment,
  settleUnconfirmedStripePayments,
  type SettleDeps,
} from "@/lib/payments/settle-unconfirmed";
import { createStubStripeClient } from "@/lib/stripe/stub";
import type { StripeCheckoutSession, StripePaymentIntent } from "@/lib/stripe/types";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";

// #184 against a real Postgres: a card payment whose webhook never arrived is
// settled from Stripe before cleanup can delete it, and a webhook landing at
// the same moment as the sweep activates the package exactly once — the
// guarded update in applyTransition is the only thing standing between them,
// so it has to be seen holding on real rows.

const TEACHER_ID = "11111111-1111-4111-8111-bbbbbbbbbbbb";
const ACCOUNT = "acct_SETTLE_TEACHER";
const NOW = new Date();
const EIGHT_DAYS_AGO = new Date(NOW.getTime() - 8 * 86_400_000);

async function seedPendingCardCheckout(sessionId: string) {
  const prisma = getTestPrisma();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, 'settle', 'teacher-settle@e2e.test', true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    TEACHER_ID,
  );
  await prisma.teacher.upsert({
    where: { id: TEACHER_ID },
    update: {},
    create: {
      id: TEACHER_ID,
      email: "teacher-settle@e2e.test",
      name: "Alicia Moreno",
      timezone: "America/Mexico_City",
      bookingSlug: "teacher-settle",
      stripeAccountId: ACCOUNT,
      stripeChargesEnabled: true,
    },
  });
  const student = await prisma.student.create({
    data: { email: `${sessionId}@e2e.test`, name: "Alumno", locale: "es" },
    select: { id: true },
  });
  await prisma.teacherStudent.create({ data: { teacherId: TEACHER_ID, studentId: student.id } });
  const pkg = await prisma.package.create({
    data: {
      teacherId: TEACHER_ID,
      studentId: student.id,
      classesTotal: 10,
      classesUsed: 0,
      classDurationMin: 50,
      pricePaidMinorUnits: 150_000,
      purchasedAt: EIGHT_DAYS_AGO,
      status: "pending",
      createdAt: EIGHT_DAYS_AGO,
    },
    select: { id: true },
  });
  const payment = await prisma.payment.create({
    data: {
      packageId: pkg.id,
      amountMinorUnits: 150_000,
      status: "pending",
      provider: "stripe",
      stripeCheckoutSessionId: sessionId,
      createdAt: EIGHT_DAYS_AGO,
    },
    select: { id: true, externalReference: true },
  });
  return { packageId: pkg.id, paymentId: payment.id, externalReference: payment.externalReference };
}

function paidSession(id: string, clientRef: string): StripeCheckoutSession {
  return {
    id,
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    url: null,
    client_reference_id: clientRef,
    payment_intent: `pi_${id}`,
    customer: null,
    metadata: null,
    amount_total: 150_000,
    currency: "mxn",
  };
}

function succeededIntent(id: string): StripePaymentIntent {
  return {
    id,
    status: "succeeded",
    amount: 150_000,
    amount_received: 150_000,
    currency: "mxn",
    payment_method_types: ["card"],
    payment_method: "pm_1",
    charges: { data: [{ id: `ch_${id}`, payment_method_details: { type: "card" } }] },
  };
}

function depsWith(stripe: ReturnType<typeof createStubStripeClient>, events: string[]): SettleDeps {
  return {
    prisma: getTestPrisma(),
    getStripe: () => stripe,
    emit: async (e) => {
      events.push(e.name);
    },
  };
}

function cleanupAsking(deps: SettleDeps) {
  return cleanupAbandonedPendingPackages({
    prisma: getTestPrisma(),
    askStripe: async (p) => (await askStripeAboutPendingPayment(p, deps)).verdict,
  });
}

describeIntegration("settling card payments whose webhook never arrived (real DB)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("settles a paid session with no webhook, and cleanup then has nothing to delete", async () => {
    const seeded = await seedPendingCardCheckout("cs_NOHOOK");
    const stripe = createStubStripeClient();
    stripe.seedCheckoutSession(paidSession("cs_NOHOOK", seeded.externalReference));
    stripe.seedPaymentIntent(succeededIntent("pi_cs_NOHOOK"));
    const events: string[] = [];
    const deps = depsWith(stripe, events);

    const settle = await settleUnconfirmedStripePayments(deps);
    const cleanup = await cleanupAsking(deps);

    expect(settle).toMatchObject({ scanned: 1, settled: 1 });
    expect(cleanup.packagesDeleted).toBe(0);
    const prisma = getTestPrisma();
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: seeded.paymentId } });
    expect(payment.status).toBe("paid");
    expect(payment.providerPaymentId).toBe("pi_cs_NOHOOK");
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: seeded.packageId } });
    expect(pkg.status).toBe("active");
    // The student's receipt and the teacher's sale notice, as a webhook would.
    const notifs = await prisma.notification.findMany({ where: { paymentId: seeded.paymentId } });
    expect(notifs.map((n) => n.templateName).sort()).toEqual([
      "payment_received",
      "payment_received_teacher",
    ]);
    expect(events.sort()).toEqual(["notification.queued", "notification.queued", "payment.paid"]);
  });

  it("cleanup never deletes a paid session even if the settle step did not run first", async () => {
    const seeded = await seedPendingCardCheckout("cs_CLEANUP_ONLY");
    const stripe = createStubStripeClient();
    stripe.seedCheckoutSession(paidSession("cs_CLEANUP_ONLY", seeded.externalReference));
    stripe.seedPaymentIntent(succeededIntent("pi_cs_CLEANUP_ONLY"));

    const cleanup = await cleanupAsking(depsWith(stripe, []));

    expect(cleanup).toMatchObject({ packagesDeleted: 0, keptForStripe: 1 });
    const pkg = await getTestPrisma().package.findUniqueOrThrow({
      where: { id: seeded.packageId },
    });
    expect(pkg.status).toBe("active");
  });

  it("leaves an unpaid session alone, and cleanup deletes it once Stripe says it expired", async () => {
    const seeded = await seedPendingCardCheckout("cs_UNPAID");
    const stripe = createStubStripeClient();
    stripe.seedCheckoutSession({
      ...paidSession("cs_UNPAID", seeded.externalReference),
      status: "expired",
      payment_status: "unpaid",
      payment_intent: null,
    });
    const deps = depsWith(stripe, []);

    const settle = await settleUnconfirmedStripePayments(deps);
    const cleanup = await cleanupAsking(deps);

    expect(settle).toMatchObject({ scanned: 1, settled: 0, abandoned: 1 });
    expect(cleanup.packagesDeleted).toBe(1);
    expect(
      await getTestPrisma().package.findUnique({ where: { id: seeded.packageId } }),
    ).toBeNull();
  });

  it("activates the package exactly once when the webhook lands at the same time as the sweep", async () => {
    const seeded = await seedPendingCardCheckout("cs_RACE");
    const session = paidSession("cs_RACE", seeded.externalReference);
    const stripe = createStubStripeClient();
    stripe.seedCheckoutSession(session);
    stripe.seedPaymentIntent(succeededIntent("pi_cs_RACE"));
    const events: string[] = [];
    const deps = depsWith(stripe, events);

    const [webhook, settle] = await Promise.all([
      handleStripeWebhook(
        {
          id: "evt_RACE",
          type: "checkout.session.completed",
          data: { object: session },
          account: ACCOUNT,
        },
        { prisma: getTestPrisma(), stripe, emit: deps.emit },
      ),
      settleUnconfirmedStripePayments(deps),
    ]);

    // Exactly one of the two applied the flip; the other was a noop.
    const applied = [webhook.code === "applied", settle.settled === 1].filter(Boolean);
    expect(applied).toHaveLength(1);
    const prisma = getTestPrisma();
    const notifs = await prisma.notification.findMany({ where: { paymentId: seeded.paymentId } });
    expect(notifs).toHaveLength(2);
    expect(events.filter((e) => e === "payment.paid")).toHaveLength(1);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: seeded.packageId } });
    expect(pkg.status).toBe("active");
  });
});
