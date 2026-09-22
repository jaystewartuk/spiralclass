import { afterEach, describe, expect, it, vi } from "vitest";

// The read behind /dashboard/referrals. What is worth pinning here is not the
// SQL but the three judgements the screen depends on: a refunded referral is
// not a customer, four schema states collapse to three the teacher can act on,
// and the stored minor units come back through the currency's own exponent
// rather than a hardcoded /100.

const programFindUnique = vi.fn();
const referralCodeCount = vi.fn();
const referralFindMany = vi.fn();
const templateFindFirst = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    referralProgram: { findUnique: (...a: unknown[]) => programFindUnique(...a) },
    referralCode: { count: (...a: unknown[]) => referralCodeCount(...a) },
    referral: { findMany: (...a: unknown[]) => referralFindMany(...a) },
    packageTemplate: { findFirst: (...a: unknown[]) => templateFindFirst(...a) },
  },
}));

import { getReferralDashboard } from "@/lib/referrals/dashboard";

const TEACHER = { id: "11111111-1111-4111-8111-111111111111", pricingCurrency: "MXN" };

function referral(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    status: "rewarded",
    referredDiscountMinorUnits: 30_000,
    currency: "MXN",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    referredStudent: { name: "Friend" },
    referralCode: { owner: { name: "Referrer" } },
    payment: { amountMinorUnits: 170_000, currency: "MXN", paidAt: new Date() },
    ...over,
  };
}

afterEach(() => vi.clearAllMocks());

function stub({
  program = null as unknown,
  referrals = [] as unknown[],
  sharers = 0,
  template = null as unknown,
}) {
  programFindUnique.mockResolvedValue(program);
  referralCodeCount.mockResolvedValue(sharers);
  referralFindMany.mockResolvedValue(referrals);
  templateFindFirst.mockResolvedValue(template);
}

describe("getReferralDashboard", () => {
  it("returns off-by-default config when the teacher has never saved one", async () => {
    stub({});
    const view = await getReferralDashboard(TEACHER);
    expect(view.configured).toBe(false);
    expect(view.enabled).toBe(false);
    expect(view.referred).toEqual({ kind: "fixed", percent: null, amount: null });
    expect(view.samplePackage).toBeNull();
    expect(view.stats).toEqual({
      sharers: 0,
      friends: 0,
      rewarded: 0,
      revenueMinorUnits: 0,
      discountMinorUnits: 0,
    });
  });

  it("projects stored bps/centavos back into the units the form edits", async () => {
    stub({
      program: {
        enabled: true,
        referredKind: "percent",
        referredPercentBps: 1500,
        referredAmountMinorUnits: null,
        referrerKind: "fixed",
        referrerPercentBps: null,
        referrerAmountMinorUnits: 20_000,
        currency: "MXN",
        rewardExpiryDays: 90,
      },
    });
    const view = await getReferralDashboard(TEACHER);
    expect(view.referred).toEqual({ kind: "percent", percent: 15, amount: null });
    expect(view.referrer).toEqual({ kind: "fixed", percent: null, amount: 200 });
    expect(view.rewardExpiryDays).toBe(90);
  });

  it("reads a 0-decimal currency back by its own exponent, not /100", async () => {
    stub({
      program: {
        enabled: true,
        referredKind: "fixed",
        referredPercentBps: null,
        // ¥500 is stored as 500 — JPY has no minor unit.
        referredAmountMinorUnits: 500,
        referrerKind: "fixed",
        referrerPercentBps: null,
        referrerAmountMinorUnits: 300,
        currency: "JPY",
        rewardExpiryDays: null,
      },
    });
    const view = await getReferralDashboard({ id: TEACHER.id, pricingCurrency: "JPY" });
    expect(view.referred.amount).toBe(500);
    expect(view.referrer.amount).toBe(300);
  });

  it("leaves a refunded referral out of every total but keeps it in the list", async () => {
    stub({
      sharers: 4,
      referrals: [
        referral({ id: "a", status: "rewarded" }),
        referral({
          id: "b",
          status: "attributed",
          payment: { amountMinorUnits: 170_000, paidAt: null },
        }),
        referral({ id: "c", status: "void" }),
      ],
    });
    const view = await getReferralDashboard(TEACHER);
    expect(view.stats).toEqual({
      sharers: 4,
      // The void one is not a customer; the unpaid one is, but has paid nothing.
      friends: 2,
      rewarded: 1,
      revenueMinorUnits: 170_000,
      discountMinorUnits: 60_000,
    });
    expect(view.activity.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("collapses attributed and qualified into one 'waiting' state", async () => {
    stub({
      referrals: [
        referral({ id: "a", status: "attributed" }),
        referral({ id: "b", status: "qualified" }),
        referral({ id: "c", status: "rewarded" }),
        referral({ id: "d", status: "void" }),
      ],
    });
    const view = await getReferralDashboard(TEACHER);
    expect(view.activity.map((r) => r.status)).toEqual([
      "awaiting",
      "awaiting",
      "rewarded",
      "void",
    ]);
  });

  it("never offers a free template as the package the preview prices against", async () => {
    stub({ template: { name: "Trial", priceMinorUnits: 200_000, currency: "MXN" } });
    await getReferralDashboard(TEACHER);
    expect(templateFindFirst.mock.calls[0][0].where).toMatchObject({
      archived: false,
      priceMinorUnits: { gt: 0 },
    });
  });

  it("survives a referral whose student rows were removed", async () => {
    stub({
      referrals: [referral({ referredStudent: null, referralCode: null })],
    });
    const view = await getReferralDashboard(TEACHER);
    expect(view.activity[0]).toMatchObject({ friendName: null, referrerName: null });
  });
});
