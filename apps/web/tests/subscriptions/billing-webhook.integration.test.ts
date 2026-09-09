import { beforeEach, expect, it } from "vitest";
import { handleBillingWebhook } from "@/lib/subscriptions/billing-webhook-handler";
import { entitlementsFor } from "@/lib/subscriptions/entitlements";
import { createStubStripeClient } from "@/lib/stripe/stub";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";

// Real-DB companion to billing-webhook.test.ts (fake-prisma). What this proves
// that the unit suite can't:
//
//   * The billing webhook drives the *full* Free→Pro upgrade against real rows
//     AND the shared entitlements resolver — not just the teacher_subscriptions
//     row shape. This is the automated stand-in for the manual "subscription
//     upgrade (Free → Pro)" UAT step (/admin/uat's §J): a Free teacher's
//     webhook lands → entitlementsFor() flips isPro/caps/live-notes.
//   * activateSubscription / dropToFree persist through Prisma's real
//     unique-on-teacherId upsert path, not an in-mem Map.
//   * The past_due grace clock defends against a lagging sweep using the
//     *persisted* currentPeriodEnd, not a hand-built object.
//
// The Stripe side stays stubbed (createStubStripeClient) — the handler always
// re-fetches canonical subscription state from Stripe, and no real Billing
// account is reachable in the hermetic stack.

const PRICE_IDS = { monthly: "price_m", annual: "price_a", founding: "price_f" };
const NOW = new Date("2026-07-01T12:00:00Z");
const TEACHER_ID = "22222222-2222-4222-8222-222222222222";
const CUSTOMER_ID = "cus_upgrade_1";

function envelope(type: string, object: unknown) {
  return { id: `evt_${type}_${Date.now()}`, type, data: { object } };
}

function unix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

async function seedTeacherOnPlan(opts: {
  plan: "free" | "monthly";
  status: "trialing" | "active";
  trialEndsAt?: Date | null;
  currentPeriodEnd?: Date | null;
}): Promise<void> {
  const prisma = getTestPrisma();
  // teachers.id → better-auth `user`(id) FK (shared primary key, D-40), same
  // as the other integration seeds.
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    TEACHER_ID,
    "upgrade@e2e.test",
  );
  await prisma.teacher.create({
    data: {
      id: TEACHER_ID,
      email: "upgrade@e2e.test",
      name: "Upgrade Teacher",
      timezone: "America/Mexico_City",
      bookingSlug: "upgrade-teacher",
    },
  });
  await prisma.teacherSubscription.create({
    data: {
      teacherId: TEACHER_ID,
      plan: opts.plan,
      status: opts.status,
      currency: "MXN",
      stripeCustomerId: CUSTOMER_ID,
      trialEndsAt: opts.trialEndsAt ?? null,
      currentPeriodEnd: opts.currentPeriodEnd ?? null,
    },
  });
}

async function readSubForEntitlements() {
  const prisma = getTestPrisma();
  return prisma.teacherSubscription.findUniqueOrThrow({
    where: { teacherId: TEACHER_ID },
    select: {
      plan: true,
      status: true,
      comped: true,
      trialEndsAt: true,
      currentPeriodEnd: true,
    },
  });
}

describeIntegration("billing webhook → entitlements (real DB)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("Free (expired trial) → customer.subscription.created(active, monthly) unlocks full Pro entitlements", async () => {
    // Trial already lapsed, so this teacher is genuinely on Free BEFORE the
    // webhook — proving the flip comes from the upgrade, not a live trial.
    await seedTeacherOnPlan({
      plan: "free",
      status: "trialing",
      trialEndsAt: new Date("2026-06-01T00:00:00Z"),
    });
    const before = entitlementsFor(await readSubForEntitlements(), NOW);
    expect(before.isPro).toBe(false);
    expect(before.canUseLiveNotes).toBe(false);
    expect(before.studentLimit).not.toBe(Number.POSITIVE_INFINITY);

    const stripe = createStubStripeClient();
    stripe.seedSubscription({
      id: "sub_up",
      customer: CUSTOMER_ID,
      status: "active",
      currency: "gbp",
      current_period_end: unix("2026-08-01T00:00:00Z"),
      items: { data: [{ price: { id: "price_m" } }] },
    });

    const outcome = await handleBillingWebhook(
      envelope("customer.subscription.created", {
        id: "sub_up",
        customer: CUSTOMER_ID,
        status: "active",
        currency: "gbp",
      }),
      { prisma: getTestPrisma(), stripe, priceIds: PRICE_IDS, now: () => NOW },
    );
    expect(outcome).toMatchObject({ code: "applied", teacherId: TEACHER_ID });

    const row = await readSubForEntitlements();
    expect(row.plan).toBe("monthly");
    expect(row.status).toBe("active");

    const after = entitlementsFor(row, NOW);
    expect(after.isPro).toBe(true);
    expect(after.canUseLiveNotes).toBe(true);
    expect(after.canScheduleMaterials).toBe(true);
    expect(after.studentLimit).toBe(Number.POSITIVE_INFINITY);
    expect(after.templateLimit).toBe(Number.POSITIVE_INFINITY);
  });

  it("Pro (active monthly) → customer.subscription.deleted drops to Free entitlements", async () => {
    await seedTeacherOnPlan({
      plan: "monthly",
      status: "active",
      currentPeriodEnd: new Date("2026-08-01T00:00:00Z"),
    });
    expect(entitlementsFor(await readSubForEntitlements(), NOW).isPro).toBe(true);

    const stripe = createStubStripeClient();
    const outcome = await handleBillingWebhook(
      envelope("customer.subscription.deleted", {
        id: "sub_up",
        customer: CUSTOMER_ID,
        status: "canceled",
        currency: "gbp",
      }),
      { prisma: getTestPrisma(), stripe, priceIds: PRICE_IDS, now: () => NOW },
    );
    expect(outcome).toMatchObject({ code: "applied", action: "subscription-deleted" });

    const row = await readSubForEntitlements();
    expect(row.plan).toBe("free");
    expect(row.status).toBe("free");

    const after = entitlementsFor(row, NOW);
    expect(after.isPro).toBe(false);
    expect(after.canUseLiveNotes).toBe(false);
    expect(after.studentLimit).not.toBe(Number.POSITIVE_INFINITY);
  });

  it("invoice.payment_failed → past_due keeps Pro during grace, but the clock drops it to Free once the grace window elapses", async () => {
    await seedTeacherOnPlan({
      plan: "monthly",
      status: "active",
      currentPeriodEnd: new Date("2026-08-01T00:00:00Z"),
    });

    const stripe = createStubStripeClient();
    const outcome = await handleBillingWebhook(
      envelope("invoice.payment_failed", {
        id: "in_fail",
        customer: CUSTOMER_ID,
        subscription: "sub_up",
        amount_due: 19_900,
        status: "open",
        period_end: unix("2026-07-01T00:00:00Z"),
      }),
      { prisma: getTestPrisma(), stripe, priceIds: PRICE_IDS, now: () => NOW },
    );
    expect(outcome).toMatchObject({ code: "applied", action: "invoice-payment-failed" });

    const row = await readSubForEntitlements();
    expect(row.status).toBe("past_due");

    // Within the grace window (right after the failed period end): still Pro.
    const inGrace = entitlementsFor(row, new Date("2026-07-02T00:00:00Z"));
    expect(inGrace.isPro).toBe(true);
    expect(inGrace.isPastDue).toBe(true);

    // Far past any grace window: the resolver's clock downgrades to Free even
    // though the DB row still says past_due (defends against a lagging sweep).
    const afterGrace = entitlementsFor(row, new Date("2026-09-01T00:00:00Z"));
    expect(afterGrace.isPro).toBe(false);
    expect(afterGrace.status).toBe("free");
  });
});
