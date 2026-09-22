import { describe, expect, it } from "vitest";
import {
  ensureSubscriptionForTeacher,
  getFoundingCohortState,
  getSubscription,
  loadEntitlements,
  lockedPriceForPlan,
} from "@/lib/subscriptions/service";
import {
  FOUNDING_MAX_TEACHERS,
  PLAN_PRICE_MINOR_UNITS,
  TRIAL_DAYS,
  foundingCutoffDate,
} from "@/lib/subscriptions/config";
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

describe("ensureSubscriptionForTeacher", () => {
  it("provisions a new teacher onto a 30-day Pro trial", async () => {
    const fake = makeFakePrisma({});
    const row = await ensureSubscriptionForTeacher("t1", NOW, fake.db as never);
    expect(row.plan).toBe("free");
    expect(row.status).toBe("trialing");
    expect(row.trialEndsAt).toEqual(new Date(NOW.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000));
  });

  it("is idempotent: returns the existing row unchanged on a second call", async () => {
    const fake = makeFakePrisma({
      subs: [sub("t1", { plan: "monthly", status: "active", trialEndsAt: null })],
    });
    const row = await ensureSubscriptionForTeacher("t1", NOW, fake.db as never);
    expect(row.plan).toBe("monthly");
    expect(row.status).toBe("active");
    // Existing row wasn't reset to a fresh trial.
    expect(row.trialEndsAt).toBeNull();
    expect(fake.subs.size).toBe(1);
  });

  it("defaults `now` to the current time when not provided", async () => {
    const fake = makeFakePrisma({});
    const before = Date.now();
    const row = await ensureSubscriptionForTeacher("t1", undefined, fake.db as never);
    const after = Date.now();
    const trialEndsAt = row.trialEndsAt!.getTime();
    expect(trialEndsAt).toBeGreaterThanOrEqual(before + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    expect(trialEndsAt).toBeLessThanOrEqual(after + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  });
});

describe("getSubscription", () => {
  it("returns the row when present", async () => {
    const fake = makeFakePrisma({ subs: [sub("t1", { plan: "annual", status: "active" })] });
    const row = await getSubscription("t1", fake.db as never);
    expect(row?.plan).toBe("annual");
  });

  it("returns null for a teacher with no row (read-only, does not provision)", async () => {
    const fake = makeFakePrisma({});
    const row = await getSubscription("nope", fake.db as never);
    expect(row).toBeNull();
  });
});

describe("loadEntitlements", () => {
  it("resolves a missing subscription row to Free (never locked out)", async () => {
    const fake = makeFakePrisma({});
    const e = await loadEntitlements("ghost", NOW, fake.db as never);
    expect(e.isPro).toBe(false);
    expect(e.plan).toBe("free");
  });

  it("resolves an active paid teacher to full Pro", async () => {
    const fake = makeFakePrisma({
      subs: [sub("t1", { plan: "monthly", status: "active" })],
    });
    const e = await loadEntitlements("t1", NOW, fake.db as never);
    expect(e.isPro).toBe(true);
  });
});

describe("getFoundingCohortState", () => {
  it("uses config defaults when no cohort row exists", async () => {
    const fake = makeFakePrisma({});
    const state = await getFoundingCohortState(NOW, fake.db as never);
    expect(state.headcount).toBe(0);
    expect(state.cap).toBe(FOUNDING_MAX_TEACHERS);
    expect(state.cutoffAt).toEqual(foundingCutoffDate());
    expect(state.isOpen).toBe(true);
  });

  it("honors an ops override for cap and cutoff", async () => {
    const fake = makeFakePrisma({
      cohort: { headcount: 10, maxTeachers: 20, cutoffAt: new Date("2026-09-01T00:00:00Z") },
    });
    const state = await getFoundingCohortState(NOW, fake.db as never);
    expect(state.cap).toBe(20);
    expect(state.cutoffAt).toEqual(new Date("2026-09-01T00:00:00Z"));
    expect(state.isOpen).toBe(true);
  });

  it("reconciles headcount from the live founding-plan count when it exceeds the stored row", async () => {
    const fake = makeFakePrisma({
      cohort: { headcount: 1 },
      subs: [
        sub("t1", { plan: "founding" }),
        sub("t2", { plan: "founding" }),
        sub("t3", { plan: "founding" }),
        sub("t4", { plan: "monthly" }), // not founding — excluded from the live count.
      ],
    });
    const state = await getFoundingCohortState(NOW, fake.db as never);
    expect(state.headcount).toBe(3);
  });

  it("never lets the live count under-report a higher stored headcount", async () => {
    const fake = makeFakePrisma({
      cohort: { headcount: 45 },
      subs: [sub("t1", { plan: "founding" })],
    });
    const state = await getFoundingCohortState(NOW, fake.db as never);
    expect(state.headcount).toBe(45);
  });

  it("closes the cohort once headcount reaches the cap", async () => {
    const fake = makeFakePrisma({ cohort: { headcount: 50, maxTeachers: 50 } });
    const state = await getFoundingCohortState(NOW, fake.db as never);
    expect(state.isOpen).toBe(false);
  });

  it("closes the cohort once the cutoff date has passed, even under cap", async () => {
    const fake = makeFakePrisma({
      cohort: { headcount: 1, cutoffAt: new Date("2026-06-01T00:00:00Z") },
    });
    const state = await getFoundingCohortState(NOW, fake.db as never);
    expect(state.isOpen).toBe(false);
  });
});

describe("lockedPriceForPlan", () => {
  it("returns the current locked price (minor units) for every plan", () => {
    expect(lockedPriceForPlan("free")).toBe(PLAN_PRICE_MINOR_UNITS.free);
    expect(lockedPriceForPlan("monthly")).toBe(PLAN_PRICE_MINOR_UNITS.monthly);
    expect(lockedPriceForPlan("annual")).toBe(PLAN_PRICE_MINOR_UNITS.annual);
    expect(lockedPriceForPlan("founding")).toBe(PLAN_PRICE_MINOR_UNITS.founding);
    // Founding is locked at a discount below the standard monthly price.
    expect(lockedPriceForPlan("founding")).toBeLessThan(lockedPriceForPlan("monthly"));
  });
});
