import { beforeEach, describe, expect, it, vi } from "vitest";

// Slice 2b reward minting. The claim → mint → bind sequence must be atomic:
// as separate writes, a crash between mint and bind stranded a live orphaned
// reward code while the persisted claim state (qualified + null reward id)
// still passed the guard — so the Inngest retry minted a SECOND live code.
// The fake prisma here implements real rollback semantics for $transaction
// so that regression is observable.

vi.mock("@/lib/inngest/client", () => ({ inngest: { createFunction: () => ({}) } }));

const notifyReferrerReward = vi.fn(async () => {});
vi.mock("@/lib/referrals/notify", () => ({
  notifyReferrerReward: (...args: unknown[]) =>
    (notifyReferrerReward as (...a: unknown[]) => unknown)(...args),
}));

const trackServerEvent = vi.fn();
const flushAnalytics = vi.fn(async () => {});
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: (...args: unknown[]) =>
    (trackServerEvent as (...a: unknown[]) => unknown)(...args),
  flushAnalytics: (...args: unknown[]) => (flushAnalytics as (...a: unknown[]) => unknown)(...args),
}));

type RewardCode = { id: string; code: string; active: boolean };
type ReferralRow = {
  id: string;
  teacherId: string;
  referralCodeId: string;
  status: string;
  referrerRewardCodeId: string | null;
  qualifiedAt: Date | null;
};

const state = {
  referral: null as ReferralRow | null,
  rewardCodes: [] as RewardCode[],
  // When set, the next referral.update (the bind step) throws once —
  // simulating a crash between mint and bind.
  bindThrowsOnce: false,
};

function freshReferral(): ReferralRow {
  return {
    id: "ref1",
    teacherId: "t1",
    referralCodeId: "rc1",
    status: "attributed",
    referrerRewardCodeId: null,
    qualifiedAt: null,
  };
}

const PROGRAM = {
  enabled: true,
  referrerKind: "fixed",
  referrerPercentBps: null,
  referrerAmountMinorUnits: 15_000,
  rewardExpiryDays: null,
};

const OWNER = {
  ownerStudentId: "owner1",
  owner: { email: "owner@x.com", name: "Mira", locale: "es-MX", emailOptIn: true },
  teacher: { name: "Profe" },
};

const fakePrisma: any = {
  referral: {
    findUnique: async () => (state.referral ? { ...state.referral } : null),
    updateMany: async ({ where, data }: any) => {
      const r = state.referral;
      if (
        !r ||
        r.id !== where.id ||
        !where.status.in.includes(r.status) ||
        r.referrerRewardCodeId !== null
      ) {
        return { count: 0 };
      }
      Object.assign(r, data);
      return { count: 1 };
    },
    update: async ({ data }: any) => {
      if (state.bindThrowsOnce) {
        state.bindThrowsOnce = false;
        throw new Error("connection lost");
      }
      Object.assign(state.referral!, data);
      return state.referral;
    },
  },
  referralProgram: { findUnique: async () => PROGRAM },
  referralCode: { findUnique: async () => OWNER },
  discountCode: {
    create: async ({ data }: any) => {
      const row = { id: `dc${state.rewardCodes.length + 1}`, code: data.code, active: true };
      state.rewardCodes.push(row);
      return { id: row.id, code: row.code };
    },
  },
  // Interactive transaction with real rollback: on throw, restore the
  // pre-transaction snapshot so partial writes don't persist.
  $transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
    const snapshot = {
      referral: state.referral ? { ...state.referral } : null,
      rewardCodes: state.rewardCodes.map((c) => ({ ...c })),
    };
    try {
      return await fn(fakePrisma);
    } catch (err) {
      state.referral = snapshot.referral;
      state.rewardCodes = snapshot.rewardCodes;
      throw err;
    }
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));

const { grantReferralRewardHandler } =
  await import("@/lib/inngest/functions/grant-referral-reward");

const runHandler = () =>
  grantReferralRewardHandler({
    event: { data: { paymentId: "pay1" } },
    step: { run: (_id: string, fn: () => any) => Promise.resolve(fn()) },
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.referral = freshReferral();
  state.rewardCodes = [];
  state.bindThrowsOnce = false;
});

describe("grantReferralRewardHandler", () => {
  it("qualifies the referral, mints exactly one reserved code, and binds it", async () => {
    const out = await runHandler();
    expect(out).toMatchObject({ rewarded: true });
    expect(state.referral).toMatchObject({ status: "rewarded", referrerRewardCodeId: "dc1" });
    expect(state.rewardCodes).toHaveLength(1);
    expect(notifyReferrerReward).toHaveBeenCalledTimes(1);
  });

  it("skips a referral that was already rewarded (redelivered event)", async () => {
    state.referral!.status = "rewarded";
    state.referral!.referrerRewardCodeId = "dc-existing";
    const out = await runHandler();
    expect(out).toEqual({ skipped: "already-handled" });
    expect(state.rewardCodes).toHaveLength(0);
  });

  it("never leaves a live orphaned code when the run dies mid-mint — the retry mints exactly one", async () => {
    // Regression: crash between mint and bind. Without the transaction the
    // minted code survived the crash unbound AND the claim state re-admitted
    // the retry, ending with two live codes for one referral.
    state.bindThrowsOnce = true;
    await expect(runHandler()).rejects.toThrow("connection lost");
    // The rollback must have discarded both the claim and the minted code.
    expect(state.rewardCodes).toHaveLength(0);
    expect(state.referral).toMatchObject({ status: "attributed", referrerRewardCodeId: null });

    // Inngest retry: succeeds and the student ends up with exactly one code.
    const out = await runHandler();
    expect(out).toMatchObject({ rewarded: true });
    expect(state.rewardCodes.filter((c) => c.active)).toHaveLength(1);
    expect(state.referral).toMatchObject({ status: "rewarded", referrerRewardCodeId: "dc1" });
  });

  it("skips when a concurrent delivery already claimed the referral", async () => {
    // The guarded claim admits attributed/qualified with a null reward id
    // only; a row someone else just flipped to rewarded matches 0 rows.
    state.referral!.status = "void";
    const out = await runHandler();
    expect(out).toEqual({ skipped: "already-handled" });
    expect(state.rewardCodes).toHaveLength(0);
  });
});
