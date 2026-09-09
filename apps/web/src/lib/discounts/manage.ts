import { Prisma } from "@prisma/client";
import { currencyForTeacher, majorToMinorUnits } from "@spiralclass/shared";

import { prisma } from "@/lib/prisma";
import { normalizeDiscountCode } from ".";
import { expiryInstant } from "./status";

// Teacher-facing management core for discount codes (slice 2a): the create /
// activate / delete / list operations. Input is already validated + typed by
// the caller; error localization stays in the web action. The redemption/
// checkout core lives in ./index.ts.
//
// It was extracted from the web server action so a second caller could drive
// the identical business rules; that caller is gone and the web action is the
// only one now.

// Raw teacher input (pesos/percent as typed), converted to the stored
// bps/minor-unit shape here so the conversion isn't duplicated per platform.
export type DiscountInput = {
  code: string;
  kind: "percent" | "fixed";
  // 1..100 when kind === "percent".
  percent?: number;
  // Major units the teacher typed when kind === "fixed" (stored as minor units).
  amountPesos?: number;
  // null = unlimited total redemptions.
  maxRedemptions?: number | null;
  perStudentLimit: number;
  // YYYY-MM-DD, or null/undefined for no expiry.
  expiresAt?: string | null;
};

export type DiscountCreateResult = { ok: true } | { ok: false; reason: "duplicate" };

export async function createDiscountCode(
  teacherId: string,
  input: DiscountInput,
): Promise<DiscountCreateResult> {
  const isPercent = input.kind === "percent";
  // Expiry is end-of-day UTC for the chosen date (valid "through" that day) —
  // see expiryInstant, which is also what the dashboard reads it back with.
  const expiresAt = input.expiresAt ? expiryInstant(input.expiresAt) : null;

  // The fixed-amount discount is denominated in the teacher's own chosen
  // pricing currency (same currency the packages it discounts are sold in).
  const teacherRow = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: { pricingCurrency: true },
  });
  const currency = currencyForTeacher(teacherRow ?? {});

  try {
    await prisma.discountCode.create({
      data: {
        teacherId,
        code: normalizeDiscountCode(input.code),
        kind: input.kind,
        percentBps: isPercent ? (input.percent as number) * 100 : null,
        // Her currency, not the MXN default: a 0-decimal currency (CLP, JPY,
        // KRW, VND) must not be multiplied by 100.
        amountMinorUnits: isPercent
          ? null
          : majorToMinorUnits(input.amountPesos as number, currency),
        currency,
        origin: "promo",
        maxRedemptions: input.maxRedemptions ?? null,
        perStudentLimit: input.perStudentLimit,
        expiresAt,
      },
    });
  } catch (err) {
    // Unique (teacher_id, code) collision.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, reason: "duplicate" };
    }
    throw err;
  }
  return { ok: true };
}

export async function setDiscountCodeActive(
  teacherId: string,
  id: string,
  active: boolean,
): Promise<{ ok: boolean }> {
  const updated = await prisma.discountCode.updateMany({
    where: { id, teacherId },
    data: { active },
  });
  return { ok: updated.count > 0 };
}

export type DiscountDeleteResult =
  { ok: true } | { ok: false; reason: "not-found" | "has-redemptions" };

export async function deleteDiscountCode(
  teacherId: string,
  id: string,
): Promise<DiscountDeleteResult> {
  // Only hard-delete an unused code; a code with redemptions is deactivated
  // instead (by the caller) so its cost/usage history survives.
  const code = await prisma.discountCode.findFirst({
    where: { id, teacherId },
    select: { id: true, _count: { select: { redemptions: true } } },
  });
  if (!code) return { ok: false, reason: "not-found" };
  if (code._count.redemptions > 0) return { ok: false, reason: "has-redemptions" };
  await prisma.discountCode.delete({ where: { id: code.id } });
  return { ok: true };
}

export type DiscountCodeView = {
  id: string;
  code: string;
  kind: "percent" | "fixed";
  percentBps: number | null;
  amountMinorUnits: number | null;
  // Currency of the fixed `amountMinorUnits` — the teacher's pricing currency
  // at the time the code was created.
  currency: string;
  active: boolean;
  maxRedemptions: number | null;
  perStudentLimit: number;
  expiresAt: string | null;
  // Redemptions whose purchase is still live (pending/active) — a refunded sale
  // frees the use, matching the web dashboard's "Used" count.
  usedCount: number;
};

export async function listDiscountCodes(teacherId: string): Promise<DiscountCodeView[]> {
  const codes = await prisma.discountCode.findMany({
    where: { teacherId, origin: "promo" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      code: true,
      kind: true,
      percentBps: true,
      amountMinorUnits: true,
      currency: true,
      active: true,
      maxRedemptions: true,
      perStudentLimit: true,
      expiresAt: true,
      _count: {
        select: {
          redemptions: { where: { package: { status: { in: ["pending", "active"] } } } },
        },
      },
    },
  });
  return codes.map((c) => ({
    id: c.id,
    code: c.code,
    kind: c.kind as "percent" | "fixed",
    percentBps: c.percentBps,
    amountMinorUnits: c.amountMinorUnits,
    currency: c.currency,
    active: c.active,
    maxRedemptions: c.maxRedemptions,
    perStudentLimit: c.perStudentLimit,
    expiresAt: c.expiresAt ? c.expiresAt.toISOString().slice(0, 10) : null,
    usedCount: c._count.redemptions,
  }));
}
