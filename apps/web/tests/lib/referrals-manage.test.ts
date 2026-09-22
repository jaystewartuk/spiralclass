import { afterEach, describe, expect, it, vi } from "vitest";

// The teacher-facing referral-program management core (read/upsert), shared by
// the web action. Mocks the prisma singleton to lock the
// reward mapping (percent→bps, major→minor units) and the read projection.

const upsert = vi.fn();
const findUnique = vi.fn();
const count = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    referralProgram: {
      upsert: (...a: unknown[]) => upsert(...a),
      findUnique: (...a: unknown[]) => findUnique(...a),
    },
    referral: { count: (...a: unknown[]) => count(...a) },
    // saveReferralProgram resolves the teacher's settlement currency from their
    // region. MX → MXN.
    teacher: { findUnique: async () => ({ platformRegion: "MX" }) },
  },
}));

import { getReferralProgram, saveReferralProgram } from "@/lib/referrals/manage";

const TEACHER = "11111111-1111-4111-8111-111111111111";

afterEach(() => vi.clearAllMocks());

describe("saveReferralProgram", () => {
  it("maps a fixed friend reward + percent referrer reward to stored columns", async () => {
    upsert.mockResolvedValue({});
    await saveReferralProgram(TEACHER, {
      enabled: true,
      referred: { kind: "fixed", amountPesos: 50 },
      referrer: { kind: "percent", percent: 10 },
      rewardExpiryDays: 30,
    });
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ teacherId: TEACHER });
    expect(arg.create).toMatchObject({
      teacherId: TEACHER,
      enabled: true,
      referredKind: "fixed",
      referredPercentBps: null,
      referredAmountMinorUnits: 5000,
      referrerKind: "percent",
      referrerPercentBps: 1000,
      referrerAmountMinorUnits: null,
      currency: "MXN",
      rewardExpiryDays: 30,
    });
    // update mirrors create minus the teacherId.
    expect(arg.update).toMatchObject({ enabled: true, referrerPercentBps: 1000 });
  });

  it("defaults a missing reward expiry to null", async () => {
    upsert.mockResolvedValue({});
    await saveReferralProgram(TEACHER, {
      enabled: false,
      referred: { kind: "percent", percent: 5 },
      referrer: { kind: "fixed", amountPesos: 20 },
    });
    expect(upsert.mock.calls[0][0].create.rewardExpiryDays).toBeNull();
  });
});

describe("getReferralProgram", () => {
  it("projects stored bps/minor units back to whole percent/major units", async () => {
    findUnique.mockResolvedValue({
      enabled: true,
      referredKind: "percent",
      referredPercentBps: 1500,
      referredAmountMinorUnits: null,
      referrerKind: "fixed",
      referrerPercentBps: null,
      referrerAmountMinorUnits: 5000,
      rewardExpiryDays: 60,
    });
    count.mockResolvedValue(3);
    expect(await getReferralProgram(TEACHER)).toEqual({
      enabled: true,
      referredKind: "percent",
      referredPercent: 15,
      referredPesos: null,
      referrerKind: "fixed",
      referrerPercent: null,
      referrerPesos: 50,
      rewardExpiryDays: 60,
      rewarded: 3,
    });
  });

  // The write half goes through the currency-aware `majorToMinorUnits`; this
  // read used a hardcoded /100, so a 0-decimal currency came back as a
  // hundredth of what was saved — and re-submitting that prefilled form
  // stored the hundredth. Both halves are currency-aware now.
  it("reads a 0-decimal currency back by its own exponent", async () => {
    findUnique.mockResolvedValue({
      enabled: true,
      referredKind: "fixed",
      referredPercentBps: null,
      referredAmountMinorUnits: 500,
      referrerKind: "fixed",
      referrerPercentBps: null,
      referrerAmountMinorUnits: 300,
      currency: "JPY",
      rewardExpiryDays: null,
    });
    count.mockResolvedValue(0);
    const view = await getReferralProgram(TEACHER);
    expect(view.referredPesos).toBe(500);
    expect(view.referrerPesos).toBe(300);
  });

  it("returns disabled defaults when no program exists", async () => {
    findUnique.mockResolvedValue(null);
    count.mockResolvedValue(0);
    const view = await getReferralProgram(TEACHER);
    expect(view).toMatchObject({
      enabled: false,
      referredKind: "fixed",
      referrerKind: "fixed",
      rewarded: 0,
    });
  });
});
