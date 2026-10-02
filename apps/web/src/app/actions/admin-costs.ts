"use server";

import { issueMessage, type TFunction } from "@spiralclass/shared";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { getPreferredLocale } from "@/lib/i18n";
import {
  majorToMinorUnits,
  KNOWN_EXPENSE_VENDORS,
  EXPENSE_CATEGORIES,
  type ExpenseVendor,
  createT,
} from "@spiralclass/shared";
import { revalidateAfterAction } from "@/lib/revalidate";

export type AdminCostsActionState = { error?: string; ok?: boolean } | undefined;

// Small fixed set of currencies actual vendor bills arrive in — not the same
// list as Payment/SubscriptionInvoice (this app has no live multi-currency
// support; see the `currency` comment on PlatformExpense in schema.prisma).
const EXPENSE_CURRENCIES = ["MXN", "USD", "GBP"] as const;

const periodMonthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "web.action.admin.invalidMonth")
  .transform((v) => new Date(`${v}-01T00:00:00.000Z`));

const baseExpenseSchema = z.object({
  vendor: z.enum(KNOWN_EXPENSE_VENDORS),
  vendorLabel: z.string().trim().max(80).optional(),
  category: z.enum(EXPENSE_CATEGORIES),
  amount: z.coerce.number().positive("El monto debe ser mayor a cero"),
  currency: z.enum(EXPENSE_CURRENCIES),
  periodMonth: periodMonthSchema,
  notes: z.string().trim().max(500).optional(),
});

// "other" needs a human-readable name to be worth anything on the chart/table
// — every other vendor already has one via KNOWN_EXPENSE_VENDORS + i18n.
function missingVendorLabelError(
  data: { vendor: ExpenseVendor; vendorLabel?: string },
  t: TFunction,
): string | null {
  if (data.vendor === "other" && !data.vendorLabel) {
    return t("admin.costs.missingVendorLabel");
  }
  return null;
}

function readExpenseFields(formData: FormData) {
  return {
    vendor: formData.get("vendor"),
    vendorLabel: formData.get("vendorLabel") || undefined,
    category: formData.get("category"),
    amount: formData.get("amount"),
    currency: formData.get("currency"),
    periodMonth: formData.get("periodMonth"),
    notes: formData.get("notes") || undefined,
  };
}

export async function createExpenseAction(
  _prev: AdminCostsActionState,
  formData: FormData,
): Promise<AdminCostsActionState> {
  await requireAdmin("finance");
  const locale = await getPreferredLocale();
  const t = createT(locale);
  const parsed = baseExpenseSchema.safeParse(readExpenseFields(formData));
  if (!parsed.success) {
    return { error: issueMessage(parsed.error, t, "web.action.invalidData") };
  }
  const vendorLabelError = missingVendorLabelError(parsed.data, t);
  if (vendorLabelError) return { error: vendorLabelError };

  await prisma.platformExpense.create({
    data: {
      vendor: parsed.data.vendor,
      vendorLabel: parsed.data.vendor === "other" ? parsed.data.vendorLabel! : null,
      category: parsed.data.category,
      amountMinorUnits: majorToMinorUnits(parsed.data.amount, parsed.data.currency),
      currency: parsed.data.currency,
      periodMonth: parsed.data.periodMonth,
      notes: parsed.data.notes || null,
    },
  });

  revalidateAfterAction("/admin/costs");
  return { ok: true };
}

const updateExpenseSchema = baseExpenseSchema.extend({ id: z.string().min(1) });

export async function updateExpenseAction(
  _prev: AdminCostsActionState,
  formData: FormData,
): Promise<AdminCostsActionState> {
  await requireAdmin("finance");
  const locale = await getPreferredLocale();
  const t = createT(locale);
  const parsed = updateExpenseSchema.safeParse({
    id: formData.get("id"),
    ...readExpenseFields(formData),
  });
  if (!parsed.success) {
    return { error: issueMessage(parsed.error, t, "web.action.invalidData") };
  }
  const vendorLabelError = missingVendorLabelError(parsed.data, t);
  if (vendorLabelError) return { error: vendorLabelError };

  const existing = await prisma.platformExpense.findUnique({ where: { id: parsed.data.id } });
  if (!existing) {
    return { error: t("web.action.admin.expenseNotFound") };
  }

  await prisma.platformExpense.update({
    where: { id: parsed.data.id },
    data: {
      vendor: parsed.data.vendor,
      vendorLabel: parsed.data.vendor === "other" ? parsed.data.vendorLabel! : null,
      category: parsed.data.category,
      amountMinorUnits: majorToMinorUnits(parsed.data.amount, parsed.data.currency),
      currency: parsed.data.currency,
      periodMonth: parsed.data.periodMonth,
      notes: parsed.data.notes || null,
    },
  });

  revalidateAfterAction("/admin/costs");
  return { ok: true };
}

const deleteExpenseSchema = z.object({ id: z.string().min(1) });

export async function deleteExpenseAction(
  _prev: AdminCostsActionState,
  formData: FormData,
): Promise<AdminCostsActionState> {
  await requireAdmin("finance");
  const locale = await getPreferredLocale();
  const t = createT(locale);
  const parsed = deleteExpenseSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) {
    return { error: t("web.action.invalidData") };
  }

  const existing = await prisma.platformExpense.findUnique({ where: { id: parsed.data.id } });
  if (!existing) {
    return { error: t("web.action.admin.expenseNotFound") };
  }

  await prisma.platformExpense.delete({ where: { id: parsed.data.id } });
  revalidateAfterAction("/admin/costs");
  return { ok: true };
}
