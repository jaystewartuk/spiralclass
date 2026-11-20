import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatMinorUnits } from "@spiralclass/shared";

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
  // The teacher each referral code belongs to. A code is reachable only
  // through `where` keys that match it, as in Prisma.
  codeTeacher: { rc1: "t1" } as Record<string, string>,
  // When set, the referral the handler reads names this teacher while the
  // stored row names its own — the claim and the bind must then match nothing.
  readTeacherOverride: null as string | null,
  // Every `where` the claim and the bind were called with.
  referralWrites: [] as Array<{ op: string; where: Record<string, unknown> }>,
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

let programOverride: Record<string, unknown> = {};
let ownerLocale = "es";

const OWNER = {
  ownerStudentId: "owner1",
  owner: { email: "owner@x.com", name: "Mira", locale: "es", emailOptIn: true },
  teacher: { name: "Profe" },
};

const fakePrisma: any = {
  referral: {
    findUnique: async () =>
      state.referral
        ? {
            ...state.referral,
            ...(state.readTeacherOverride ? { teacherId: state.readTeacherOverride } : {}),
          }
        : null,
    updateMany: async ({ where, data }: any) => {
      state.referralWrites.push({ op: "updateMany", where });
      const r = state.referral;
      if (
        !r ||
        r.id !== where.id ||
        (where.teacherId !== undefined && r.teacherId !== where.teacherId) ||
        !where.status.in.includes(r.status) ||
        r.referrerRewardCodeId !== null
      ) {
        return { count: 0 };
      }
      Object.assign(r, data);
      return { count: 1 };
    },
    update: async ({ where, data }: any) => {
      state.referralWrites.push({ op: "update", where });
      const r = state.referral;
      if (
        !r ||
        r.id !== where.id ||
        (where.teacherId !== undefined && r.teacherId !== where.teacherId)
      ) {
        throw new Error("Record to update not found");
      }
      if (state.bindThrowsOnce) {
        state.bindThrowsOnce = false;
        throw new Error("connection lost");
      }
      Object.assign(state.referral!, data);
      return state.referral;
    },
  },
  referralProgram: { findUnique: async () => ({ ...PROGRAM, ...programOverride }) },
  referralCode: {
    findUnique: async ({ where }: any) => {
      const teacherId = state.codeTeacher[where.id];
      if (!teacherId) return null;
      if (where.teacherId !== undefined && where.teacherId !== teacherId) return null;
      return { ...OWNER, owner: { ...OWNER.owner, locale: ownerLocale } };
    },
  },
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
  state.codeTeacher = { rc1: "t1" };
  state.readTeacherOverride = null;
  state.referralWrites = [];
  programOverride = {};
  ownerLocale = "es";
});

describe("grantReferralRewardHandler", () => {
  it("qualifies the referral, mints exactly one reserved code, and binds it", async () => {
    const out = await runHandler();
    expect(out).toMatchObject({ rewarded: true });
    expect(state.referral).toMatchObject({ status: "rewarded", referrerRewardCodeId: "dc1" });
    expect(state.rewardCodes).toHaveLength(1);
    expect(notifyReferrerReward).toHaveBeenCalledTimes(1);
  });

  // The label was formatted with no currency, so it fell back to MXN: a
  // teacher whose program is in euros told the student their reward was in
  // pesos. It is the program's currency now, in the student's number format.
  it("labels the reward in the program's currency, written for the student", async () => {
    programOverride = { currency: "EUR" };
    ownerLocale = "fr";
    await runHandler();
    const { rewardLabel } = (notifyReferrerReward.mock.calls[0] as unknown[])[0] as {
      rewardLabel: string;
    };
    expect(rewardLabel).toBe(formatMinorUnits(15_000, "EUR", "fr"));
    expect(rewardLabel).toContain("EUR");
    expect(rewardLabel).not.toContain("MXN");
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

// D-175 / #62: the reward is minted under the teacher the Referral names, for
// the student who owns the referral code. The code lookup, the claim and the
// bind each name that teacher, so a code or a referral row belonging to
// another teacher can never be the one that is rewarded or written.
describe("the referral reward is scoped to the referral's teacher", () => {
  it("does not reward through a referral code that belongs to another teacher", async () => {
    state.referral!.referralCodeId = "rc-other";
    state.codeTeacher = { rc1: "t1", "rc-other": "t2" };
    const out = await runHandler();
    expect(out).toEqual({ skipped: "no-owner" });
    expect(state.rewardCodes).toHaveLength(0);
    expect(state.referral).toMatchObject({ status: "attributed", referrerRewardCodeId: null });
    expect(notifyReferrerReward).not.toHaveBeenCalled();
  });

  it("claims and binds the referral under the teacher it was read for", async () => {
    await runHandler();
    expect(state.referralWrites).toEqual([
      { op: "updateMany", where: expect.objectContaining({ id: "ref1", teacherId: "t1" }) },
      { op: "update", where: { id: "ref1", teacherId: "t1" } },
    ]);
  });

  it("claims nothing when the stored row belongs to a different teacher than the one read", async () => {
    // The row says t1; the handler is made to read it as t2, and the code is
    // t2's too, so the claim is the only thing left to refuse. It must match
    // no row rather than qualify another teacher's referral.
    state.readTeacherOverride = "t2";
    state.codeTeacher = { rc1: "t2" };
    const out = await runHandler();
    expect(out).toEqual({ skipped: "race-lost" });
    expect(state.rewardCodes).toHaveLength(0);
    expect(state.referral).toMatchObject({ status: "attributed", referrerRewardCodeId: null });
  });
});
