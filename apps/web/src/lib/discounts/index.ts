import { type TFunction } from "@spiralclass/shared";
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

// How long after a card checkout is created it can still be paid. Stripe caps
// a Checkout Session's life at 24 hours, and we never set it shorter; the
// extra hour covers the gap between writing the Payment row and creating the
// session. Past this, a `failed` card payment is final: the session that could
// have retried it is gone.
export const CHECKOUT_PAYABLE_WINDOW_MS = 25 * 60 * 60 * 1000;

// THE definition of a purchase that still spends a discount use or a referral
// first purchase (issue #74). Every counter — checkout, referral, the
// teacher's dashboard, the refund clawback — imports this rather than restating
// it, so the till and the dashboard cannot disagree.
//
// A purchase counts while it is `active`, or `pending` and still payable. The
// webhook fails the Payment of an expired or declined card checkout but leaves
// its Package `pending`, so `pending` alone kept those uses spent for good.
// A `failed` payment is not proof the purchase is dead, though: a declined
// card leaves the Checkout Session open, the student can try another card on
// it, and the payment goes failed → paid (lib/payments/state.ts). So a pending
// package stops counting only when every payment on it is a failed CARD
// payment older than the payable window. A pending payment of any age keeps
// counting — a bank transfer may be in flight (D-145) — and a failed manual
// transfer already expires its package (failWisePaymentAction).
export function redemptionCountsWhere(now: Date): Prisma.PackageWhereInput {
  const payableSince = new Date(now.getTime() - CHECKOUT_PAYABLE_WINDOW_MS);
  return {
    status: { in: [PackageStatus.pending, PackageStatus.active] },
    NOT: {
      status: PackageStatus.pending,
      // `some` guards Prisma's vacuous `every`: a package with no payment row
      // at all keeps counting.
      payments: {
        some: {},
        every: { status: "failed", provider: "stripe", createdAt: { lt: payableSince } },
      },
    },
  };
}

// The limits re-checked inside the checkout transaction, with the code's row
// locked. resolveAndValidateDiscount runs once before the transaction so a bad
// code fails before any row is written; this is the check that decides. The
// lock serialises every checkout of one code, and under READ COMMITTED each
// count after it sees the redemptions the previous holder committed — so two
// checkouts at once cannot both take the last use, by the total cap or by the
// per-student limit.
export async function revalidateDiscountUnderLock(
  tx: Prisma.TransactionClient,
  args: {
    codeId: string;
    teacherId: string;
    studentId: string;
    code: string;
    baseMinorUnits: number;
    now?: Date;
  },
): Promise<DiscountValidation> {
  await tx.$queryRaw`SELECT 1 FROM discount_codes WHERE id = ${args.codeId}::uuid FOR UPDATE`;
  const result = await resolveAndValidateDiscount({ ...args, db: tx });
  // Resolved by its text again; it must still be the row that was locked.
  if (result.ok && result.codeId !== args.codeId) return { ok: false, reason: "not_found" };
  return result;
}

export type DiscountRejectReason =
  "not_found" | "inactive" | "expired" | "max_redemptions" | "per_student";

export type DiscountValidation =
  | { ok: true; codeId: string; discountMinorUnits: number; finalMinorUnits: number }
  | { ok: false; reason: DiscountRejectReason };

// Resolve a code for a (teacher, student) and decide whether it can apply to a
// purchase of `baseMinorUnits`. Redemption limits are counted against redemptions
// whose purchase still counts (redemptionCountsWhere) — a refunded, superseded
// or dead purchase frees the use again, which is also what makes refund
// handling automatic.
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
  const livePackage = { package: redemptionCountsWhere(now) };

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
export function discountRejectMessage(reason: DiscountRejectReason, t: TFunction): string {
  switch (reason) {
    case "not_found":
      return t("web.action.discount.invalid");
    case "inactive":
      return t("web.action.discount.inactive");
    case "expired":
      return t("web.action.discount.expired");
    case "max_redemptions":
      return t("web.action.discount.limitReached");
    case "per_student":
      return t("web.action.discount.alreadyUsed");
  }
}
