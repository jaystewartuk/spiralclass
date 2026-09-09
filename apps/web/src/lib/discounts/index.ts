import { PackageStatus, type Prisma } from "@prisma/client";

// Discount-code primitive (slice 2a, docs/features/referrals-discounts.md).
// Pure helpers + one DB validator, shared by the checkout core and the teacher
// dashboard. A discount is teacher-funded by construction (a lower charge =
// lower settled net), so there's no money to "grant" — only a reduced amount.

// Codes are matched case-insensitively; we store and compare the normalized
// form (trim + upper-case) so no functional index is needed.
export function normalizeDiscountCode(raw: string): string {
  return raw.trim().toUpperCase();
}

// The minor units to subtract from a base price for a given code. Percent is
// in basis points (1500 = 15%); fixed is a flat minor-unit amount. Clamped to
// [0, base] so a discount can never produce a negative charge.
export function computeDiscountMinorUnits(
  code: { kind: "percent" | "fixed"; percentBps: number | null; amountMinorUnits: number | null },
  baseMinorUnits: number,
): number {
  if (baseMinorUnits <= 0) return 0;
  const raw =
    code.kind === "percent"
      ? Math.round((baseMinorUnits * (code.percentBps ?? 0)) / 10_000)
      : (code.amountMinorUnits ?? 0);
  return Math.max(0, Math.min(baseMinorUnits, raw));
}

export type DiscountRejectReason =
  "not_found" | "inactive" | "expired" | "max_redemptions" | "per_student";

export type DiscountValidation =
  | { ok: true; codeId: string; discountMinorUnits: number; finalMinorUnits: number }
  | { ok: false; reason: DiscountRejectReason };

// Resolve a code for a (teacher, student) and decide whether it can apply to a
// purchase of `baseMinorUnits`. Redemption limits are counted against redemptions
// whose package is still pending/active — a refunded or superseded purchase
// frees the use again, which is also what makes refund handling automatic.
//
// `db` accepts the PrismaClient or a transaction client; callers validate just
// before the checkout transaction (read-only) so an invalid code fails before
// any rows are written.
export async function resolveAndValidateDiscount(args: {
  db: Prisma.TransactionClient;
  teacherId: string;
  studentId: string;
  code: string;
  baseMinorUnits: number;
  now?: Date;
}): Promise<DiscountValidation> {
  const code = normalizeDiscountCode(args.code);
  const now = args.now ?? new Date();

  const row = await args.db.discountCode.findUnique({
    where: { teacherId_code: { teacherId: args.teacherId, code } },
    select: {
      id: true,
      kind: true,
      percentBps: true,
      amountMinorUnits: true,
      active: true,
      maxRedemptions: true,
      perStudentLimit: true,
      expiresAt: true,
      reservedForStudentId: true,
    },
  });
  if (!row) return { ok: false, reason: "not_found" };
  if (!row.active) return { ok: false, reason: "inactive" };
  if (row.expiresAt && row.expiresAt <= now) return { ok: false, reason: "expired" };
  // A reserved reward code (slice 2b) is private to one student. To anyone else
  // it should look like it doesn't exist rather than leak its existence.
  if (row.reservedForStudentId && row.reservedForStudentId !== args.studentId) {
    return { ok: false, reason: "not_found" };
  }

  // A redemption only "counts" while its purchase is live.
  const livePackage = {
    package: { status: { in: [PackageStatus.pending, PackageStatus.active] } },
  };

  if (row.maxRedemptions != null) {
    const total = await args.db.discountRedemption.count({
      where: { discountCodeId: row.id, ...livePackage },
    });
    if (total >= row.maxRedemptions) return { ok: false, reason: "max_redemptions" };
  }

  const perStudent = await args.db.discountRedemption.count({
    where: { discountCodeId: row.id, studentId: args.studentId, ...livePackage },
  });
  if (perStudent >= row.perStudentLimit) return { ok: false, reason: "per_student" };

  const discountMinorUnits = computeDiscountMinorUnits(row, args.baseMinorUnits);
  return {
    ok: true,
    codeId: row.id,
    discountMinorUnits,
    finalMinorUnits: args.baseMinorUnits - discountMinorUnits,
  };
}

// Localized, student-facing message for a rejected code (shown at checkout).
export function discountRejectMessage(reason: DiscountRejectReason, en: boolean): string {
  switch (reason) {
    case "not_found":
      return en ? "That code isn't valid." : "Ese código no es válido.";
    case "inactive":
      return en ? "That code is no longer active." : "Ese código ya no está activo.";
    case "expired":
      return en ? "That code has expired." : "Ese código ya venció.";
    case "max_redemptions":
      return en ? "That code has reached its limit." : "Ese código alcanzó su límite.";
    case "per_student":
      return en ? "You've already used that code." : "Ya usaste ese código.";
  }
}
