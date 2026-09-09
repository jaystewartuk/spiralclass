import { describe, expect, it } from "vitest";
import { runSubscriptionSweep } from "@/lib/subscriptions/sweep";
import { makeFakePrisma, type FakeSub } from "./_fake-prisma";

const NOW = new Date("2026-06-12T00:00:00Z");

function sub(teacherId: string, partial: Partial<FakeSub>): FakeSub {
  return {
    teacherId,
    plan: "free",
    status: "trialing",
    lockedPriceMinorUnits: null,
    currency: "MXN",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    comped: false,
    ...partial,
  };
}

describe("subscription sweep", () => {
  it("drops expired trials and lapsed past_due to Free; comped untouched", async () => {
    const fake = makeFakePrisma({
      subs: [
        // Expired trial → free.
        sub("t1", { status: "trialing", trialEndsAt: new Date("2026-06-01T00:00:00Z") }),
        // Trial still running → untouched.
        sub("t2", { status: "trialing", trialEndsAt: new Date("2026-07-01T00:00:00Z") }),
        // past_due, grace elapsed (period end > 7 days ago) → free.
        sub("t3", {
          plan: "monthly",
          status: "past_due",
          currentPeriodEnd: new Date("2026-06-01T00:00:00Z"),
        }),
        // Comped → never dropped even though "trial" passed.
        sub("t4", {
          status: "trialing",
          trialEndsAt: new Date("2026-01-01T00:00:00Z"),
          comped: true,
        }),
      ],
    });

    const result = await runSubscriptionSweep({ prisma: fake.db, now: () => NOW });
    expect(result.droppedFromTrial).toBe(1);
    expect(result.droppedFromPastDue).toBe(1);
    expect(fake.subs.get("t1")!.status).toBe("free");
    expect(fake.subs.get("t2")!.status).toBe("trialing");
    expect(fake.subs.get("t3")!.status).toBe("free");
    // Comped sub is filtered out of the trial query (comped:false), so untouched.
    expect(fake.subs.get("t4")!.status).toBe("trialing");
  });

  it("sends a one-time trial-ending nudge ~3 days out (deduped)", async () => {
    const fake = makeFakePrisma({
      subs: [sub("t1", { status: "trialing", trialEndsAt: new Date("2026-06-14T00:00:00Z") })],
    });
    const r1 = await runSubscriptionSweep({ prisma: fake.db, now: () => NOW });
    expect(r1.trialEndingNudges).toBe(1);
    expect(
      fake.notifications.filter((n) => n.templateName === "subscription_trial_ending"),
    ).toHaveLength(1);

    // Re-running doesn't re-nudge (dedup via the existing notification row).
    const r2 = await runSubscriptionSweep({ prisma: fake.db, now: () => NOW });
    expect(r2.trialEndingNudges).toBe(0);
  });

  it("boundary: trialEndsAt exactly == now is dropped (lte inclusive)", async () => {
    const fake = makeFakePrisma({
      subs: [sub("t1", { status: "trialing", trialEndsAt: NOW })],
    });
    const result = await runSubscriptionSweep({ prisma: fake.db, now: () => NOW });
    expect(result.droppedFromTrial).toBe(1);
    expect(fake.subs.get("t1")!.status).toBe("free");
  });

  it("boundary: currentPeriodEnd exactly at the grace cutoff is dropped (lte inclusive)", async () => {
    const graceCutoff = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fake = makeFakePrisma({
      subs: [sub("t1", { plan: "monthly", status: "past_due", currentPeriodEnd: graceCutoff })],
    });
    const result = await runSubscriptionSweep({ prisma: fake.db, now: () => NOW });
    expect(result.droppedFromPastDue).toBe(1);
    expect(fake.subs.get("t1")!.status).toBe("free");
  });

  it("comped past_due subscriptions are never dropped even past the grace period", async () => {
    const fake = makeFakePrisma({
      subs: [
        sub("t1", {
          plan: "monthly",
          status: "past_due",
          currentPeriodEnd: new Date("2026-01-01T00:00:00Z"),
          comped: true,
        }),
      ],
    });
    const result = await runSubscriptionSweep({ prisma: fake.db, now: () => NOW });
    expect(result.droppedFromPastDue).toBe(0);
    expect(fake.subs.get("t1")!.status).toBe("past_due");
  });

  it("daysRemaining floors to a minimum of 1 when the trial ends in under a day", async () => {
    const fake = makeFakePrisma({
      subs: [
        // 2 hours out — still within the 3-day notice window, less than 1 day remaining.
        sub("t1", {
          status: "trialing",
          trialEndsAt: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
        }),
      ],
    });
    await runSubscriptionSweep({ prisma: fake.db, now: () => NOW });
    const notif = fake.notifications.find((n) => n.templateName === "subscription_trial_ending");
    expect(notif?.metadata?.daysRemaining).toBe(1);
  });

  it("dedup applies independently per teacher within the same ending-soon cohort", async () => {
    const fake = makeFakePrisma({
      subs: [
        sub("already-nudged", {
          status: "trialing",
          trialEndsAt: new Date("2026-06-14T00:00:00Z"),
        }),
        sub("fresh", { status: "trialing", trialEndsAt: new Date("2026-06-15T00:00:00Z") }),
      ],
    });
    // Pre-seed a trial-ending notice for one teacher only.
    await fake.db.notification.create({
      data: {
        teacherId: "already-nudged",
        templateName: "subscription_trial_ending",
        recipientType: "teacher",
      },
    });

    const result = await runSubscriptionSweep({ prisma: fake.db, now: () => NOW });
    expect(result.trialEndingNudges).toBe(1);
    const teacherIds = fake.notifications
      .filter((n) => n.templateName === "subscription_trial_ending")
      .map((n) => n.teacherId);
    expect(teacherIds).toEqual(["already-nudged", "fresh"]);
  });

  it("emits notification.queued with the new notification id and teacher id for the nudge", async () => {
    const fake = makeFakePrisma({
      subs: [sub("t1", { status: "trialing", trialEndsAt: new Date("2026-06-14T00:00:00Z") })],
    });
    const emitted: Array<{ name: string; teacherId: string; notificationId: string }> = [];
    const result = await runSubscriptionSweep({
      prisma: fake.db,
      now: () => NOW,
      emit: async (e) =>
        void emitted.push({
          name: e.name,
          teacherId: e.data.teacherId,
          notificationId: e.data.notificationId,
        }),
    });
    expect(result.trialEndingNudges).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].name).toBe("notification.queued");
    expect(emitted[0].teacherId).toBe("t1");
    const storedId = fake.notifications.find(
      (n) => n.templateName === "subscription_trial_ending",
    )!.id;
    expect(emitted[0].notificationId).toBe(storedId);
  });

  it("swallows an emit failure — the nudge still counts and the sweep does not throw", async () => {
    const fake = makeFakePrisma({
      subs: [sub("t1", { status: "trialing", trialEndsAt: new Date("2026-06-14T00:00:00Z") })],
    });
    const result = await runSubscriptionSweep({
      prisma: fake.db,
      now: () => NOW,
      emit: async () => {
        throw new Error("emit transport down");
      },
    });
    expect(result.trialEndingNudges).toBe(1);
    expect(
      fake.notifications.filter((n) => n.templateName === "subscription_trial_ending"),
    ).toHaveLength(1);
  });
});
