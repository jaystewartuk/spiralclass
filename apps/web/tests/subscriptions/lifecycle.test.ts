import { describe, expect, it } from "vitest";
import { activateSubscription, dropToFree, markPastDue } from "@/lib/subscriptions/lifecycle";
import { entitlementsFor } from "@/lib/subscriptions/entitlements";
import { makeFakePrisma, type FakeSub } from "./_fake-prisma";

const NOW = new Date("2026-06-12T00:00:00Z");

function trialingSub(teacherId: string): FakeSub {
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
  };
}

describe("activateSubscription", () => {
  it("activates a monthly plan and locks the price", async () => {
    const fake = makeFakePrisma({ subs: [trialingSub("t1")] });
    await activateSubscription(
      { prisma: fake.db, now: () => NOW },
      {
        teacherId: "t1",
        plan: "monthly",
        lockedPriceMinorUnits: 19_900,
        stripeSubscriptionId: "sub_1",
      },
    );
    const row = fake.subs.get("t1")!;
    expect(row.status).toBe("active");
    expect(row.plan).toBe("monthly");
    expect(row.lockedPriceMinorUnits).toBe(19_900);
    expect(row.trialEndsAt).toBeNull();
  });

  it("founding: locks 149, bumps cohort headcount, sends price-locked notice", async () => {
    const fake = makeFakePrisma({ subs: [trialingSub("t1")], cohort: { headcount: 4 } });
    const emitted: string[] = [];
    await activateSubscription(
      {
        prisma: fake.db,
        now: () => NOW,
        emit: async (e) => void emitted.push(e.data.notificationId),
      },
      { teacherId: "t1", plan: "founding", lockedPriceMinorUnits: 14_900 },
    );
    expect(fake.subs.get("t1")!.plan).toBe("founding");
    expect(fake.subs.get("t1")!.lockedPriceMinorUnits).toBe(14_900);
    expect(fake.cohort!.headcount).toBe(5);
    expect(
      fake.notifications.some((n) => n.templateName === "subscription_founding_price_locked"),
    ).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  // Regression: the into-founding transition was detected from a read taken
  // BEFORE the transaction, so two concurrent webhook deliveries (e.g.
  // subscription.created racing invoice.paid) both saw a stale non-founding
  // plan and both bumped the cohort headcount.
  it("bumps the founding headcount once when two activations race", async () => {
    const fake = makeFakePrisma({
      subs: [{ ...trialingSub("t1"), plan: "monthly", status: "active" }],
      cohort: { headcount: 4 },
    });
    const deps = { prisma: fake.db, now: () => NOW };
    const input = { teacherId: "t1", plan: "founding" as const, lockedPriceMinorUnits: 14_900 };

    // Interleave: the loser takes its pre-transaction reads first, then the
    // winner lands fully before the loser's transaction body runs.
    let raced = false;
    const origTx = fake.db.$transaction.bind(fake.db);
    fake.db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
      if (!raced) {
        raced = true;
        await activateSubscription(deps, input); // the concurrent winner
      }
      return origTx(fn);
    };

    await activateSubscription(deps, input); // the loser
    expect(fake.subs.get("t1")!.plan).toBe("founding");
    expect(fake.cohort!.headcount).toBe(5); // exactly one bump
    expect(
      fake.notifications.filter((n) => n.templateName === "subscription_founding_price_locked"),
    ).toHaveLength(1);
  });
});

describe("markPastDue", () => {
  it("flips to past_due (full Pro kept) and sends payment-failed notice once", async () => {
    const active: FakeSub = { ...trialingSub("t1"), plan: "monthly", status: "active" };
    const fake = makeFakePrisma({ subs: [active] });
    await markPastDue({ prisma: fake.db, now: () => NOW }, { teacherId: "t1" });
    const row = fake.subs.get("t1")!;
    expect(row.status).toBe("past_due");
    // Still Pro during the grace window.
    expect(entitlementsFor(row, NOW).isPro).toBe(true);
    expect(
      fake.notifications.filter((n) => n.templateName === "subscription_payment_failed"),
    ).toHaveLength(1);

    // Re-firing doesn't re-notify.
    await markPastDue({ prisma: fake.db, now: () => NOW }, { teacherId: "t1" });
    expect(
      fake.notifications.filter((n) => n.templateName === "subscription_payment_failed"),
    ).toHaveLength(1);
  });

  // Regression: a single failed renewal makes Stripe fire TWO separate events —
  // invoice.payment_failed AND customer.subscription.updated(past_due) — each
  // claimed under its own event id and processed CONCURRENTLY. markPastDue read
  // the status BEFORE a plain unconditional update, so both deliveries observed
  // "active" and both enqueued a `subscription_payment_failed` notice — the
  // teacher got two "update your card" messages. The transition into past_due
  // must be an atomic guarded flip so only the winner notifies.
  it("sends the payment-failed notice once when two failed-renewal webhooks race", async () => {
    const active: FakeSub = { ...trialingSub("t1"), plan: "monthly", status: "active" };
    const fake = makeFakePrisma({ subs: [active] });
    const deps = { prisma: fake.db, now: () => NOW };
    const input = { teacherId: "t1" };

    // Interleave: the loser reads a still-live "active" row, THEN a concurrent
    // winner lands fully (flip → past_due + notice) before the loser writes —
    // exactly the race two independently-claimed webhook deliveries create.
    let winnerRan = false;
    const origFindUnique = fake.db.teacherSubscription.findUnique.bind(fake.db.teacherSubscription);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fake.db.teacherSubscription.findUnique = async (args: any) => {
      const row = await origFindUnique(args);
      if (!winnerRan && row?.status === "active") {
        winnerRan = true;
        await markPastDue(deps, input); // the concurrent winner
      }
      return row;
    };

    await markPastDue(deps, input); // the loser

    expect(fake.subs.get("t1")!.status).toBe("past_due");
    // Exactly one notice — the loser's guarded flip matched 0 rows and bailed.
    expect(
      fake.notifications.filter((n) => n.templateName === "subscription_payment_failed"),
    ).toHaveLength(1);
  });

  // Regression: markPastDue used to OVERWRITE currentPeriodEnd with the value
  // its caller passed — and the failed-renewal webhook passed the invoice's
  // period_end, which Stripe has already advanced to the END of the UNPAID
  // period (~a full cycle out). The grace (graceEnd = currentPeriodEnd + 7d) was
  // then anchored a cycle late, extending full Pro + the reduced commission tier
  // for ~a month, and the daily sweep (currentPeriodEnd <= now - 7d) could never
  // fire. The paid-through anchor must be preserved.
  it("preserves the paid-through period end as the grace anchor (no cycle-long over-grant)", async () => {
    const paidThrough = new Date("2026-06-10T00:00:00Z"); // last SUCCESSFUL period end
    const active: FakeSub = {
      ...trialingSub("t1"),
      plan: "monthly",
      status: "active",
      currentPeriodEnd: paidThrough,
    };
    const fake = makeFakePrisma({ subs: [active] });

    // The renewal fails at ~paidThrough; callers pass NO period end now.
    await markPastDue({ prisma: fake.db, now: () => paidThrough }, { teacherId: "t1" });

    const row = fake.subs.get("t1")!;
    expect(row.status).toBe("past_due");
    // Anchor unchanged — NOT the future unpaid period end.
    expect(row.currentPeriodEnd).toEqual(paidThrough);

    // Grace runs paid-through + 7 days: Pro during, gone after.
    const duringGrace = new Date(paidThrough.getTime() + 6 * 24 * 3600_000);
    const afterGrace = new Date(paidThrough.getTime() + 8 * 24 * 3600_000);
    expect(entitlementsFor(row, duringGrace).isPro).toBe(true);
    expect(entitlementsFor(row, afterGrace).isPro).toBe(false);
  });

  // Regression: a late/out-of-order failed-payment webhook flipped teachers
  // who had already canceled (or dropped to free) into past_due — a status
  // that re-grants full Pro, indefinitely when currentPeriodEnd is null.
  it("never resurrects a free or canceled teacher into the grace window", async () => {
    const fake = makeFakePrisma({
      subs: [
        { ...trialingSub("t1"), plan: "free", status: "free" },
        { ...trialingSub("t2"), plan: "free", status: "canceled" },
      ],
    });
    await markPastDue({ prisma: fake.db, now: () => NOW }, { teacherId: "t1" });
    await markPastDue({ prisma: fake.db, now: () => NOW }, { teacherId: "t2" });
    expect(fake.subs.get("t1")!.status).toBe("free");
    expect(fake.subs.get("t2")!.status).toBe("canceled");
    expect(entitlementsFor(fake.subs.get("t1")!, NOW).isPro).toBe(false);
    expect(
      fake.notifications.filter((n) => n.templateName === "subscription_payment_failed"),
    ).toHaveLength(0);
  });
});

describe("dropToFree", () => {
  it("drops to Free, sends canceled notice, and never touches comped teachers", async () => {
    const active: FakeSub = { ...trialingSub("t1"), plan: "monthly", status: "active" };
    const comped: FakeSub = {
      ...trialingSub("t2"),
      plan: "founding",
      status: "active",
      comped: true,
    };
    const fake = makeFakePrisma({ subs: [active, comped] });

    await dropToFree({ prisma: fake.db, now: () => NOW }, { teacherId: "t1", reason: "canceled" });
    expect(fake.subs.get("t1")!.status).toBe("free");
    expect(fake.subs.get("t1")!.plan).toBe("free");
    expect(fake.notifications.some((n) => n.templateName === "subscription_canceled")).toBe(true);

    // Comped teacher is left fully Pro.
    await dropToFree(
      { prisma: fake.db, now: () => NOW },
      { teacherId: "t2", reason: "past_due_grace_elapsed" },
    );
    expect(fake.subs.get("t2")!.status).toBe("active");
    expect(fake.subs.get("t2")!.comped).toBe(true);
  });
});
