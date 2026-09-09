import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { previewRewardMinorUnits } from "@spiralclass/shared";
import { computeDiscountMinorUnits } from "@/lib/discounts";
import { resolveReferralForCheckout, referralRejectMessage } from "@/lib/referrals";

// Slice 2b — referral resolution at checkout (docs/features/referrals-discounts.md).
// The DB-backed mint/qualify/clawback paths are covered by integration tests;
// here we pin the resolution branches (not-a-referral, program off, self-
// referral by id or email, and the referred-discount math) via a fake client.

function fakeDb(opts: {
  refCode: {
    id: string;
    active: boolean;
    ownerStudentId: string;
    owner: { email: string | null };
  } | null;
  program: {
    enabled: boolean;
    referredKind: "percent" | "fixed";
    referredPercentBps: number | null;
    referredAmountMinorUnits: number | null;
  } | null;
  // Prior attributions for this (teacher, referred student) and the status of
  // each one's package — drives the first-purchase-only guard.
  priorReferralPackages?: Array<{ packageId: string; status: string }>;
}): Prisma.TransactionClient {
  const priors = opts.priorReferralPackages ?? [];
  return {
    referralCode: { findUnique: async () => opts.refCode },
    referralProgram: { findUnique: async () => opts.program },
    referral: {
      findMany: async () => priors.map((p) => ({ packageId: p.packageId })),
    },
    package: {
      count: async ({ where }: { where: { id: { in: string[] }; status: { in: string[] } } }) =>
        priors.filter(
          (p) => where.id.in.includes(p.packageId) && where.status.in.includes(p.status),
        ).length,
    },
  } as unknown as Prisma.TransactionClient;
}

const program = {
  enabled: true,
  referredKind: "fixed" as const,
  referredPercentBps: null,
  referredAmountMinorUnits: 20_000,
};

const args = (
  db: Prisma.TransactionClient,
  over: Partial<{ studentId: string; studentEmail: string | null }> = {},
) => ({
  db,
  teacherId: "t1",
  studentId: over.studentId ?? "friend",
  studentEmail: over.studentEmail ?? "friend@example.com",
  code: "MIRA-1234",
  baseMinorUnits: 100_000,
});

describe("resolveReferralForCheckout", () => {
  it("returns not_a_referral when the code isn't a referral code", async () => {
    const r = await resolveReferralForCheckout(args(fakeDb({ refCode: null, program })));
    expect(r).toEqual({ ok: false, reason: "not_a_referral" });
  });

  it("rejects an inactive referral code", async () => {
    const db = fakeDb({
      refCode: { id: "rc1", active: false, ownerStudentId: "owner", owner: { email: "o@x.com" } },
      program,
    });
    expect(await resolveReferralForCheckout(args(db))).toEqual({ ok: false, reason: "inactive" });
  });

  it("rejects when the program is off", async () => {
    const db = fakeDb({
      refCode: { id: "rc1", active: true, ownerStudentId: "owner", owner: { email: "o@x.com" } },
      program: { ...program, enabled: false },
    });
    expect(await resolveReferralForCheckout(args(db))).toEqual({
      ok: false,
      reason: "program_off",
    });
  });

  it("blocks self-referral by student id", async () => {
    const db = fakeDb({
      refCode: { id: "rc1", active: true, ownerStudentId: "me", owner: { email: "o@x.com" } },
      program,
    });
    expect(await resolveReferralForCheckout(args(db, { studentId: "me" }))).toEqual({
      ok: false,
      reason: "self_referral",
    });
  });

  it("blocks self-referral by matching email (case-insensitive)", async () => {
    const db = fakeDb({
      refCode: {
        id: "rc1",
        active: true,
        ownerStudentId: "owner",
        owner: { email: "Me@Example.com" },
      },
      program,
    });
    expect(await resolveReferralForCheckout(args(db, { studentEmail: "me@example.com" }))).toEqual({
      ok: false,
      reason: "self_referral",
    });
  });

  it("blocks a second redemption once the student has a live referred purchase", async () => {
    // Regression: without the first-purchase guard the same friend could
    // redeem the code on every repurchase, minting the referrer a fresh
    // reward each time.
    const db = fakeDb({
      refCode: { id: "rc1", active: true, ownerStudentId: "owner", owner: { email: "o@x.com" } },
      program,
      priorReferralPackages: [{ packageId: "pkg1", status: "active" }],
    });
    expect(await resolveReferralForCheckout(args(db))).toEqual({
      ok: false,
      reason: "already_redeemed",
    });
  });

  it("still allows the retry when the only prior attribution was superseded/refunded", async () => {
    const db = fakeDb({
      refCode: { id: "rc1", active: true, ownerStudentId: "owner", owner: { email: "o@x.com" } },
      program,
      priorReferralPackages: [
        { packageId: "pkg1", status: "expired" },
        { packageId: "pkg2", status: "refunded" },
      ],
    });
    const r = await resolveReferralForCheckout(args(db));
    expect(r.ok).toBe(true);
  });

  it("resolves a valid referral and computes the referred discount", async () => {
    const db = fakeDb({
      refCode: {
        id: "rc1",
        active: true,
        ownerStudentId: "owner",
        owner: { email: "owner@x.com" },
      },
      program,
    });
    const r = await resolveReferralForCheckout(args(db));
    expect(r).toEqual({
      ok: true,
      referralCodeId: "rc1",
      ownerStudentId: "owner",
      discountMinorUnits: 20_000,
      finalMinorUnits: 80_000,
    });
  });

  it("computes a percentage referred discount", async () => {
    const db = fakeDb({
      refCode: {
        id: "rc1",
        active: true,
        ownerStudentId: "owner",
        owner: { email: "owner@x.com" },
      },
      program: {
        enabled: true,
        referredKind: "percent",
        referredPercentBps: 1000,
        referredAmountMinorUnits: null,
      },
    });
    const r = await resolveReferralForCheckout(args(db));
    expect(r.ok && r.discountMinorUnits).toBe(10_000); // 10% of 100000
  });
});

describe("referralRejectMessage", () => {
  it("localizes self-referral", () => {
    expect(referralRejectMessage("self_referral", true)).toMatch(/own referral/i);
    expect(referralRejectMessage("self_referral", false)).toMatch(/propio/i);
  });

  it("localizes already-redeemed", () => {
    expect(referralRejectMessage("already_redeemed", true)).toMatch(/first purchase/i);
    expect(referralRejectMessage("already_redeemed", false)).toMatch(/primera compra/i);
  });
});

// The teacher's live cost breakdown on /dashboard/referrals is computed from
// `previewRewardMinorUnits`, which reads the shape she is TYPING (whole percent,
// major units) rather than the stored code shape (basis points, centavos) the
// checkout resolver reads. Two entry points, one rule — and this is the only
// module where both are importable, so the agreement is asserted here.
describe("previewRewardMinorUnits agrees with computeDiscountMinorUnits", () => {
  const BASE = 199_900; // MX$1,999.00 — deliberately not a round number.

  it("matches on every percent from 1 to 100", () => {
    for (let percent = 1; percent <= 100; percent++) {
      expect(previewRewardMinorUnits({ kind: "percent", percent, amount: null }, BASE, "MXN")).toBe(
        computeDiscountMinorUnits(
          { kind: "percent", percentBps: percent * 100, amountMinorUnits: null },
          BASE,
        ),
      );
    }
  });

  it("matches on fixed amounts, including one larger than the package", () => {
    for (const amount of [1, 50, 199, 1_999, 5_000]) {
      expect(previewRewardMinorUnits({ kind: "fixed", percent: null, amount }, BASE, "MXN")).toBe(
        computeDiscountMinorUnits(
          { kind: "fixed", percentBps: null, amountMinorUnits: amount * 100 },
          BASE,
        ),
      );
    }
  });
});
