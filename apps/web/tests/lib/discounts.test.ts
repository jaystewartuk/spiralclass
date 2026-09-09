import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  computeDiscountMinorUnits,
  normalizeDiscountCode,
  resolveAndValidateDiscount,
  discountRejectMessage,
} from "@/lib/discounts";

// Slice 2a — the discount-code primitive (docs/features/referrals-discounts.md).
// The DB-backed integration path is covered separately; here we lock down the
// pure math + every validation branch via a hand-rolled client, so a regression
// in clamping, rounding, expiry, or the redemption caps can't slip through.

describe("normalizeDiscountCode", () => {
  it("trims and upper-cases", () => {
    expect(normalizeDiscountCode("  summer25 ")).toBe("SUMMER25");
  });
});

describe("computeDiscountMinorUnits", () => {
  const pct = (bps: number) => ({
    kind: "percent" as const,
    percentBps: bps,
    amountMinorUnits: null,
  });
  const fixed = (c: number) => ({ kind: "fixed" as const, percentBps: null, amountMinorUnits: c });

  it("computes a percentage", () => {
    expect(computeDiscountMinorUnits(pct(1500), 100_000)).toBe(15_000); // 15%
  });

  it("rounds a fractional percentage", () => {
    expect(computeDiscountMinorUnits(pct(3300), 100)).toBe(33); // 33% of 1.00 MXN
  });

  it("applies a fixed amount", () => {
    expect(computeDiscountMinorUnits(fixed(20_000), 100_000)).toBe(20_000);
  });

  it("never exceeds the base price (clamps a too-large fixed discount)", () => {
    expect(computeDiscountMinorUnits(fixed(200_000), 100_000)).toBe(100_000);
  });

  it("never exceeds the base price (clamps 100%+)", () => {
    expect(computeDiscountMinorUnits(pct(10_000), 50_000)).toBe(50_000);
  });

  it("is zero on a zero base", () => {
    expect(computeDiscountMinorUnits(fixed(20_000), 0)).toBe(0);
  });
});

// Minimal fake of the Prisma client surface resolveAndValidateDiscount touches.
function fakeDb(opts: {
  code: {
    id: string;
    kind: "percent" | "fixed";
    percentBps: number | null;
    amountMinorUnits: number | null;
    active: boolean;
    maxRedemptions: number | null;
    perStudentLimit: number;
    expiresAt: Date | null;
  } | null;
  totalCount?: number;
  perStudentCount?: number;
}): Prisma.TransactionClient {
  return {
    discountCode: { findUnique: async () => opts.code },
    discountRedemption: {
      count: async (args: { where?: { studentId?: string } }) =>
        args.where?.studentId !== undefined ? (opts.perStudentCount ?? 0) : (opts.totalCount ?? 0),
    },
  } as unknown as Prisma.TransactionClient;
}

const baseCode = {
  id: "code-1",
  kind: "percent" as const,
  percentBps: 1000, // 10%
  amountMinorUnits: null,
  active: true,
  maxRedemptions: null as number | null,
  perStudentLimit: 1,
  expiresAt: null as Date | null,
};

const args = (db: Prisma.TransactionClient, code = "SAVE10") => ({
  db,
  teacherId: "t1",
  studentId: "s1",
  code,
  baseMinorUnits: 100_000,
  now: new Date("2026-06-26T12:00:00Z"),
});

describe("resolveAndValidateDiscount", () => {
  it("rejects an unknown code", async () => {
    const r = await resolveAndValidateDiscount(args(fakeDb({ code: null })));
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects an inactive code", async () => {
    const r = await resolveAndValidateDiscount(
      args(fakeDb({ code: { ...baseCode, active: false } })),
    );
    expect(r).toEqual({ ok: false, reason: "inactive" });
  });

  it("rejects an expired code", async () => {
    const r = await resolveAndValidateDiscount(
      args(fakeDb({ code: { ...baseCode, expiresAt: new Date("2026-06-01T00:00:00Z") } })),
    );
    expect(r).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects when the total redemption cap is reached", async () => {
    const r = await resolveAndValidateDiscount(
      args(fakeDb({ code: { ...baseCode, maxRedemptions: 5 }, totalCount: 5 })),
    );
    expect(r).toEqual({ ok: false, reason: "max_redemptions" });
  });

  it("rejects when the per-student limit is reached", async () => {
    const r = await resolveAndValidateDiscount(
      args(fakeDb({ code: { ...baseCode, perStudentLimit: 1 }, perStudentCount: 1 })),
    );
    expect(r).toEqual({ ok: false, reason: "per_student" });
  });

  it("accepts a valid code and returns the discounted total", async () => {
    const r = await resolveAndValidateDiscount(args(fakeDb({ code: baseCode })));
    expect(r).toEqual({
      ok: true,
      codeId: "code-1",
      discountMinorUnits: 10_000,
      finalMinorUnits: 90_000,
    });
  });

  it("matches case-insensitively (normalizes before lookup)", async () => {
    const r = await resolveAndValidateDiscount(args(fakeDb({ code: baseCode }), "save10"));
    expect(r.ok).toBe(true);
  });
});

describe("discountRejectMessage", () => {
  it("localizes each reason", () => {
    expect(discountRejectMessage("expired", true)).toMatch(/expired/i);
    expect(discountRejectMessage("expired", false)).toMatch(/venc/i);
    expect(discountRejectMessage("per_student", true)).toMatch(/already used/i);
  });
});
