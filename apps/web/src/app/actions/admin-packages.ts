"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { writeOverride } from "@/lib/audit";
import { getPreferredLocale } from "@/lib/i18n";
import { addMonths } from "@/lib/dates";
import { revalidateAfterAction } from "@/lib/revalidate";

export type AdminPackageActionState = { error?: string; ok?: boolean } | undefined;

const cancelSchema = z.object({
  packageId: z.string().uuid("ID inválido"),
  reason: z.string().trim().min(1, "Motivo requerido").max(280),
});

// Marks a package `refunded` without touching the payment. Use when
// the student should not be able to use any remaining classes
// (e.g., teacher off-boarded, fraud) and a real Stripe refund is
// being handled separately or is not applicable. The booking flow
// filters `package.status === "active"` so canceled packages
// immediately block new bookings; existing scheduled bookings are
// not touched.
export async function cancelPackageAction(
  _prev: AdminPackageActionState,
  formData: FormData,
): Promise<AdminPackageActionState> {
  const actor = await requireAdmin("support");
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = cancelSchema.safeParse({
    packageId: formData.get("packageId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos"),
    };
  }

  const pkg = await prisma.package.findUnique({
    where: { id: parsed.data.packageId },
    select: { id: true, status: true, teacherId: true },
  });
  if (!pkg) return { error: en ? "Package not found" : "Paquete no encontrado" };
  if (pkg.status === "refunded") return { error: en ? "Already canceled" : "Ya está cancelado" };

  await prisma.$transaction(async (tx) => {
    await tx.package.update({
      where: { id: pkg.id },
      data: { status: "refunded" },
    });
    await writeOverride({
      tx,
      teacherId: pkg.teacherId,
      targetType: "package",
      targetId: pkg.id,
      action: "cancel_package",
      reason: parsed.data.reason,
      before: { status: pkg.status },
      after: { status: "refunded" },
      actor,
    });
  });

  revalidateAfterAction(`/admin/packages/${pkg.id}`);
  return { ok: true };
}

const extendSchema = z.object({
  packageId: z.string().uuid("ID inválido"),
  months: z.coerce.number().int().min(1, "1 mes mínimo").max(24, "Máximo 24 meses"),
  reason: z.string().trim().min(1, "Motivo requerido").max(280),
});

// Pushes the package expiry out by N months. If expiry was null
// (no expiration set) we leave it null — that's already permissive
// and extending an unbounded date is meaningless.
export async function extendPackageExpirationAction(
  _prev: AdminPackageActionState,
  formData: FormData,
): Promise<AdminPackageActionState> {
  const actor = await requireAdmin("support");
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = extendSchema.safeParse({
    packageId: formData.get("packageId"),
    months: formData.get("months"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos"),
    };
  }

  const pkg = await prisma.package.findUnique({
    where: { id: parsed.data.packageId },
    select: { id: true, expiresAt: true, teacherId: true },
  });
  if (!pkg) return { error: en ? "Package not found" : "Paquete no encontrado" };
  if (!pkg.expiresAt) {
    return {
      error: en
        ? "This package doesn't expire; there's nothing to extend"
        : "Este paquete no expira; no hay nada que extender",
    };
  }

  // UTC calendar-month math (not setMonth/getMonth, which run on the
  // server process's local timezone — unpinned in this deployment).
  const next = addMonths(pkg.expiresAt, parsed.data.months);

  await prisma.$transaction(async (tx) => {
    await tx.package.update({
      where: { id: pkg.id },
      data: { expiresAt: next },
    });
    await writeOverride({
      tx,
      teacherId: pkg.teacherId,
      targetType: "package",
      targetId: pkg.id,
      action: "extend_expiration",
      reason: parsed.data.reason,
      before: { expiresAt: pkg.expiresAt?.toISOString() ?? null },
      after: { expiresAt: next.toISOString(), months: parsed.data.months },
      actor,
    });
  });

  revalidateAfterAction(`/admin/packages/${pkg.id}`);
  return { ok: true };
}
