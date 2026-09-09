import crypto from "node:crypto";
import { PackageStatus, Prisma } from "@prisma/client";
import { computeDiscountMinorUnits, normalizeDiscountCode } from "@/lib/discounts";

// Student→student referrals (slice 2b, docs/features/referrals-discounts.md), built
// on the discount-code primitive. A referrer's code resolves at checkout to the
// teacher's configured referred-side discount and records a Referral; when the
// friend's payment settles, the referrer is minted a reserved single-use
// discount code (their reward).

// 12-char unguessable token (no separators) — friendly to type/share, and at
// 48 bits not realistically enumerable. Was 8 (32 bits), widened per the
// security audit (L-4) alongside the Wise reference, since both derive a
// shareable handle from a UUID prefix.
function generateReferralToken(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
}

// One code per (teacher, student), minted lazily on first share. Retries on the
// (vanishingly rare) token collision; tolerates a concurrent create by
// re-reading the per-owner unique row.
export async function getOrCreateReferralCode(
  db: Prisma.TransactionClient,
  teacherId: string,
  ownerStudentId: string,
): Promise<string> {
  const existing = await db.referralCode.findUnique({
    where: { teacherId_ownerStudentId: { teacherId, ownerStudentId } },
    select: { code: true },
  });
  if (existing) return existing.code;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralToken();
    try {
      await db.referralCode.create({ data: { teacherId, ownerStudentId, code } });
      return code;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // Either another request created this owner's row, or a token clash.
        const row = await db.referralCode.findUnique({
          where: { teacherId_ownerStudentId: { teacherId, ownerStudentId } },
          select: { code: true },
        });
        if (row) return row.code;
        continue; // token clash — try a fresh token
      }
      throw err;
    }
  }
  throw new Error("referral-code-mint-failed");
}

export type ReferralCheckout =
  | {
      ok: true;
      referralCodeId: string;
      ownerStudentId: string;
      discountMinorUnits: number;
      finalMinorUnits: number;
    }
  | {
      ok: false;
      reason: "not_a_referral" | "program_off" | "inactive" | "self_referral" | "already_redeemed";
    };

// Resolve a code typed at checkout as a referral. Returns `not_a_referral` when
// the code isn't a referral code at all (so the caller can fall back to the
// generic "invalid code" message). Self-referral is blocked by both identity
// and email so a buyer can't redeem their own link under a second address.
export async function resolveReferralForCheckout(args: {
  db: Prisma.TransactionClient;
  teacherId: string;
  studentId: string;
  studentEmail: string | null;
  code: string;
  baseMinorUnits: number;
}): Promise<ReferralCheckout> {
  const code = normalizeDiscountCode(args.code);
  const refCode = await args.db.referralCode.findUnique({
    where: { teacherId_code: { teacherId: args.teacherId, code } },
    select: {
      id: true,
      active: true,
      ownerStudentId: true,
      owner: { select: { email: true } },
    },
  });
  if (!refCode) return { ok: false, reason: "not_a_referral" };
  if (!refCode.active) return { ok: false, reason: "inactive" };

  const program = await args.db.referralProgram.findUnique({
    where: { teacherId: args.teacherId },
    select: {
      enabled: true,
      referredKind: true,
      referredPercentBps: true,
      referredAmountMinorUnits: true,
    },
  });
  if (!program || !program.enabled) return { ok: false, reason: "program_off" };

  // No self-referral: not your own code, and not the same inbox under a second
  // roster row.
  const sameEmail =
    args.studentEmail != null &&
    refCode.owner.email != null &&
    refCode.owner.email.toLowerCase() === args.studentEmail.toLowerCase();
  if (refCode.ownerStudentId === args.studentId || sameEmail) {
    return { ok: false, reason: "self_referral" };
  }

  // First-purchase only (REFERRALS.md): the referred discount applies to the
  // friend's FIRST package with this teacher — without this, the same friend
  // could redeem a referral code on every repurchase, minting the referrer a
  // fresh reward each time. Attributions stop counting when their package
  // expired or was refunded (same convention as discount redemptions), so an
  // abandoned/superseded checkout never blocks a retry of the first purchase.
  const prior = await args.db.referral.findMany({
    where: { teacherId: args.teacherId, referredStudentId: args.studentId },
    select: { packageId: true },
  });
  if (prior.length > 0) {
    const live = await args.db.package.count({
      where: {
        id: { in: prior.map((p) => p.packageId) },
        status: { in: [PackageStatus.pending, PackageStatus.active] },
      },
    });
    if (live > 0) return { ok: false, reason: "already_redeemed" };
  }

  const discountMinorUnits = computeDiscountMinorUnits(
    {
      kind: program.referredKind,
      percentBps: program.referredPercentBps,
      amountMinorUnits: program.referredAmountMinorUnits,
    },
    args.baseMinorUnits,
  );
  return {
    ok: true,
    referralCodeId: refCode.id,
    ownerStudentId: refCode.ownerStudentId,
    discountMinorUnits,
    finalMinorUnits: args.baseMinorUnits - discountMinorUnits,
  };
}

// Mint the referrer's reward: a single-use discount code reserved to them,
// carrying the program's referrer-side value. Retries on token collision.
// Origin `referral_referrer` keeps it out of the teacher's promo dashboard.
export async function mintReservedRewardCode(
  db: Prisma.TransactionClient,
  args: {
    teacherId: string;
    ownerStudentId: string;
    kind: "percent" | "fixed";
    percentBps: number | null;
    amountMinorUnits: number | null;
    // The reward's currency — mirrors the referral program's currency (the
    // teacher's own chosen pricing currency).
    currency: string;
    expiresAt: Date | null;
  },
): Promise<{ id: string; code: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `RW-${generateReferralToken()}`;
    try {
      const created = await db.discountCode.create({
        data: {
          teacherId: args.teacherId,
          code,
          kind: args.kind,
          percentBps: args.kind === "percent" ? args.percentBps : null,
          amountMinorUnits: args.kind === "fixed" ? args.amountMinorUnits : null,
          currency: args.currency,
          origin: "referral_referrer",
          maxRedemptions: 1,
          perStudentLimit: 1,
          reservedForStudentId: args.ownerStudentId,
          expiresAt: args.expiresAt,
        },
        select: { id: true, code: true },
      });
      return created;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        attempt < 4
      ) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("reward-code-mint-failed");
}

// Refund clawback: when a qualifying payment is refunded, void the referrer's
// minted reward IF they haven't already redeemed it (a redemption against a
// live package). If it's already spent, the teacher bears it — we leave it and
// the caller logs. The referred-side discount needs no action: its referral's
// package flips to refunded, so it stops counting on its own. Best-effort and
// idempotent; safe to call from both refund paths.
export async function voidReferralRewardForPayment(
  db: Prisma.TransactionClient,
  paymentId: string,
): Promise<{ voided: boolean; alreadyRedeemed?: boolean }> {
  const ref = await db.referral.findUnique({
    where: { paymentId },
    select: { id: true, referrerRewardCodeId: true, status: true },
  });
  if (!ref || !ref.referrerRewardCodeId || ref.status === "void") return { voided: false };

  const redeemed = await db.discountRedemption.count({
    where: {
      discountCodeId: ref.referrerRewardCodeId,
      package: { status: { in: [PackageStatus.pending, PackageStatus.active] } },
    },
  });
  if (redeemed > 0) return { voided: false, alreadyRedeemed: true };

  await db.discountCode.update({
    where: { id: ref.referrerRewardCodeId },
    data: { active: false },
  });
  await db.referral.update({ where: { id: ref.id }, data: { status: "void" } });
  return { voided: true };
}

export function referralRejectMessage(
  reason: Exclude<ReferralCheckout & { ok: false }, { ok: true }>["reason"],
  en: boolean,
): string {
  switch (reason) {
    case "self_referral":
      return en
        ? "You can't use your own referral code."
        : "No puedes usar tu propio código de referido.";
    case "already_redeemed":
      return en
        ? "Referral codes only apply to your first purchase."
        : "Los códigos de referido solo aplican en tu primera compra.";
    case "program_off":
    case "inactive":
    case "not_a_referral":
      return en ? "That code isn't valid." : "Ese código no es válido.";
  }
}
