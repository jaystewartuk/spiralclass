"use server";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { writeOverride } from "@/lib/audit";
import { getPreferredLocale } from "@/lib/i18n";
import { INTEGRATION_CATEGORIES, USAGE_METRICS, pricingModelSchema } from "@spiralclass/shared";
import { revalidateAfterAction } from "@/lib/revalidate";

// Financial Intelligence estimate layer (D-86, S4) — the write side of
// `/admin/economics`: Integration registry CRUD, UsageInput upsert/delete,
// and the singleton EconomicsAssumptions update. Mirrors admin-costs.ts
// (finance role, Zod, revalidatePath, `writeOverride` audit) but every write
// here touches the ESTIMATE layer, never PlatformExpense/money-metrics.ts.

export type AdminEconomicsActionState = { error?: string; ok?: boolean } | undefined;

const ECONOMICS_PATH = "/admin/economics";

// Loose on purpose (mirrors economics-pricing.ts's own currencySchema) — the
// FX layer, not this form, decides which currencies actually resolve to GBP;
// an unresolved one is a deliberately surfaced warning, not a rejected input.
const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Moneda inválida");

const periodMonthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "Mes inválido")
  .transform((v) => new Date(`${v}-01T00:00:00.000Z`));

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));
}

// --- Integrations ------------------------------------------------------

const baseIntegrationSchema = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, "Usa minúsculas, números y guiones bajos"),
  name: z.string().trim().min(1).max(120),
  category: z.enum(INTEGRATION_CATEGORIES),
  currency: currencySchema,
  purpose: optionalText(500),
  billingModel: optionalText(200),
  billingUrl: optionalText(300),
  docsUrl: optionalText(300),
  notes: optionalText(500),
  pricingModelJson: z.string().min(1),
});

function readIntegrationFields(formData: FormData) {
  return {
    key: formData.get("key"),
    name: formData.get("name"),
    category: formData.get("category"),
    currency: formData.get("currency"),
    purpose: formData.get("purpose") || undefined,
    billingModel: formData.get("billingModel") || undefined,
    billingUrl: formData.get("billingUrl") || undefined,
    docsUrl: formData.get("docsUrl") || undefined,
    notes: formData.get("notes") || undefined,
    pricingModelJson: formData.get("pricingModelJson"),
  };
}

// The pricing-model textarea is free-form JSON (D-86 MVP — a structured
// editor is a fast-follow), so it needs its own two-stage parse: JSON syntax
// first, then the shared discriminated-union schema. Both failures return
// the same shape as a Zod field error so the form can render one error slot.
function parsePricingModelField(
  raw: string,
  en: boolean,
): { ok: true; value: Prisma.InputJsonValue } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: en ? "Invalid pricing model JSON" : "JSON de modelo de precios inválido",
    };
  }
  const parsed = pricingModelSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: en
        ? `Invalid pricing model: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`
        : `Modelo de precios inválido: ${parsed.error.issues[0]?.message ?? "no coincide con el esquema"}`,
    };
  }
  return { ok: true, value: parsed.data as Prisma.InputJsonValue };
}

export async function createIntegrationAction(
  _prev: AdminEconomicsActionState,
  formData: FormData,
): Promise<AdminEconomicsActionState> {
  const actor = await requireAdmin("finance");
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = baseIntegrationSchema.safeParse(readIntegrationFields(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos") };
  }
  const pricingModel = parsePricingModelField(parsed.data.pricingModelJson, en);
  if (!pricingModel.ok) return { error: pricingModel.error };

  const { _max } = await prisma.integration.aggregate({ _max: { sortOrder: true } });

  try {
    const row = await prisma.integration.create({
      data: {
        key: parsed.data.key,
        name: parsed.data.name,
        category: parsed.data.category,
        currency: parsed.data.currency,
        purpose: parsed.data.purpose ?? null,
        billingModel: parsed.data.billingModel ?? null,
        billingUrl: parsed.data.billingUrl ?? null,
        docsUrl: parsed.data.docsUrl ?? null,
        notes: parsed.data.notes ?? null,
        pricingModel: pricingModel.value,
        sortOrder: (_max.sortOrder ?? -1) + 1,
      },
    });
    await writeOverride({
      teacherId: null,
      targetType: "system",
      targetId: row.id,
      action: "create_integration",
      reason: `Created integration "${parsed.data.key}" via /admin/economics`,
      after: { key: parsed.data.key, name: parsed.data.name, category: parsed.data.category },
      actor,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { error: en ? "That key is already in use" : "Esa clave ya está en uso" };
    }
    throw err;
  }

  revalidateAfterAction(ECONOMICS_PATH);
  return { ok: true };
}

const updateIntegrationSchema = baseIntegrationSchema.extend({ id: z.string().min(1) });

export async function updateIntegrationAction(
  _prev: AdminEconomicsActionState,
  formData: FormData,
): Promise<AdminEconomicsActionState> {
  const actor = await requireAdmin("finance");
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = updateIntegrationSchema.safeParse({
    id: formData.get("id"),
    ...readIntegrationFields(formData),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos") };
  }
  const pricingModel = parsePricingModelField(parsed.data.pricingModelJson, en);
  if (!pricingModel.ok) return { error: pricingModel.error };

  const existing = await prisma.integration.findUnique({ where: { id: parsed.data.id } });
  if (!existing) {
    return { error: en ? "Integration not found" : "Integración no encontrada" };
  }

  try {
    await prisma.integration.update({
      where: { id: parsed.data.id },
      data: {
        key: parsed.data.key,
        name: parsed.data.name,
        category: parsed.data.category,
        currency: parsed.data.currency,
        purpose: parsed.data.purpose ?? null,
        billingModel: parsed.data.billingModel ?? null,
        billingUrl: parsed.data.billingUrl ?? null,
        docsUrl: parsed.data.docsUrl ?? null,
        notes: parsed.data.notes ?? null,
        pricingModel: pricingModel.value,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { error: en ? "That key is already in use" : "Esa clave ya está en uso" };
    }
    throw err;
  }

  await writeOverride({
    teacherId: null,
    targetType: "system",
    targetId: parsed.data.id,
    action: "update_integration",
    reason: `Updated integration "${parsed.data.key}" via /admin/economics`,
    before: { key: existing.key, name: existing.name, category: existing.category },
    after: { key: parsed.data.key, name: parsed.data.name, category: parsed.data.category },
    actor,
  });

  revalidateAfterAction(ECONOMICS_PATH);
  return { ok: true };
}

const toggleIntegrationActiveSchema = z.object({
  id: z.string().min(1),
  active: z.enum(["true", "false"]).transform((v) => v === "true"),
});

export async function toggleIntegrationActiveAction(
  _prev: AdminEconomicsActionState,
  formData: FormData,
): Promise<AdminEconomicsActionState> {
  const actor = await requireAdmin("finance");
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = toggleIntegrationActiveSchema.safeParse({
    id: formData.get("id"),
    active: formData.get("active"),
  });
  if (!parsed.success) return { error: en ? "Invalid data" : "Datos inválidos" };

  const existing = await prisma.integration.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return { error: en ? "Integration not found" : "Integración no encontrada" };

  await prisma.integration.update({
    where: { id: parsed.data.id },
    data: { active: parsed.data.active },
  });
  await writeOverride({
    teacherId: null,
    targetType: "system",
    targetId: parsed.data.id,
    action: parsed.data.active ? "activate_integration" : "deactivate_integration",
    reason: `${parsed.data.active ? "Activated" : "Deactivated"} integration "${existing.key}" via /admin/economics`,
    before: { active: existing.active },
    after: { active: parsed.data.active },
    actor,
  });

  revalidateAfterAction(ECONOMICS_PATH);
  return { ok: true };
}

const deleteIntegrationSchema = z.object({ id: z.string().min(1) });

export async function deleteIntegrationAction(
  _prev: AdminEconomicsActionState,
  formData: FormData,
): Promise<AdminEconomicsActionState> {
  const actor = await requireAdmin("finance");
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = deleteIntegrationSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return { error: en ? "Invalid data" : "Datos inválidos" };

  const existing = await prisma.integration.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return { error: en ? "Integration not found" : "Integración no encontrada" };

  await prisma.integration.delete({ where: { id: parsed.data.id } });
  await writeOverride({
    teacherId: null,
    targetType: "system",
    targetId: parsed.data.id,
    action: "delete_integration",
    reason: `Deleted integration "${existing.key}" via /admin/economics`,
    before: { key: existing.key, name: existing.name, category: existing.category },
    actor,
  });

  revalidateAfterAction(ECONOMICS_PATH);
  return { ok: true };
}

// --- Usage inputs --------------------------------------------------------

const usageInputSchema = z.object({
  metric: z.enum(USAGE_METRICS),
  periodMonth: periodMonthSchema,
  value: z.coerce.number().nonnegative(),
  notes: optionalText(500),
});

export async function upsertUsageInputAction(
  _prev: AdminEconomicsActionState,
  formData: FormData,
): Promise<AdminEconomicsActionState> {
  const actor = await requireAdmin("finance");
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = usageInputSchema.safeParse({
    metric: formData.get("metric"),
    periodMonth: formData.get("periodMonth"),
    value: formData.get("value"),
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos") };
  }

  const row = await prisma.usageInput.upsert({
    where: {
      metric_periodMonth: { metric: parsed.data.metric, periodMonth: parsed.data.periodMonth },
    },
    create: {
      metric: parsed.data.metric,
      periodMonth: parsed.data.periodMonth,
      value: parsed.data.value,
      notes: parsed.data.notes ?? null,
    },
    update: {
      value: parsed.data.value,
      notes: parsed.data.notes ?? null,
    },
  });

  await writeOverride({
    teacherId: null,
    targetType: "system",
    targetId: row.id,
    action: "upsert_usage_input",
    reason: `Recorded ${parsed.data.metric} usage for ${parsed.data.periodMonth.toISOString().slice(0, 7)} via /admin/economics`,
    after: {
      metric: parsed.data.metric,
      periodMonth: parsed.data.periodMonth,
      value: parsed.data.value,
    },
    actor,
  });

  revalidateAfterAction(ECONOMICS_PATH);
  return { ok: true };
}

const deleteUsageInputSchema = z.object({ id: z.string().min(1) });

export async function deleteUsageInputAction(
  _prev: AdminEconomicsActionState,
  formData: FormData,
): Promise<AdminEconomicsActionState> {
  const actor = await requireAdmin("finance");
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = deleteUsageInputSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return { error: en ? "Invalid data" : "Datos inválidos" };

  const existing = await prisma.usageInput.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return { error: en ? "Usage entry not found" : "Registro de uso no encontrado" };

  await prisma.usageInput.delete({ where: { id: parsed.data.id } });
  await writeOverride({
    teacherId: null,
    targetType: "system",
    targetId: parsed.data.id,
    action: "delete_usage_input",
    reason: `Deleted ${existing.metric} usage for ${existing.periodMonth.toISOString().slice(0, 7)} via /admin/economics`,
    before: { metric: existing.metric, periodMonth: existing.periodMonth, value: existing.value },
    actor,
  });

  revalidateAfterAction(ECONOMICS_PATH);
  return { ok: true };
}

// --- Assumptions -----------------------------------------------------------

const assumptionsSchema = z.object({
  fxUsdToGbp: z.coerce.number().positive(),
  fxMxnToGbp: z.coerce.number().positive(),
  fxEurToGbp: z.coerce.number().positive(),
  allocationBasis: z.enum(["active_teachers", "lessons", "even"]),
  fxAsOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida")
    .transform((v) => new Date(`${v}T00:00:00.000Z`)),
});

export async function updateAssumptionsAction(
  _prev: AdminEconomicsActionState,
  formData: FormData,
): Promise<AdminEconomicsActionState> {
  const actor = await requireAdmin("finance");
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = assumptionsSchema.safeParse({
    fxUsdToGbp: formData.get("fxUsdToGbp"),
    fxMxnToGbp: formData.get("fxMxnToGbp"),
    fxEurToGbp: formData.get("fxEurToGbp"),
    allocationBasis: formData.get("allocationBasis"),
    fxAsOf: formData.get("fxAsOf"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos") };
  }

  const before = await prisma.economicsAssumptions.findUnique({ where: { id: "default" } });

  await prisma.economicsAssumptions.upsert({
    where: { id: "default" },
    create: { id: "default", ...parsed.data },
    update: { ...parsed.data },
  });

  await writeOverride({
    teacherId: null,
    targetType: "system",
    targetId: "default",
    action: "update_economics_assumptions",
    reason: "Updated FX/allocation assumptions via /admin/economics",
    before: before
      ? {
          fxUsdToGbp: before.fxUsdToGbp,
          fxMxnToGbp: before.fxMxnToGbp,
          fxEurToGbp: before.fxEurToGbp,
          allocationBasis: before.allocationBasis,
        }
      : null,
    after: parsed.data,
    actor,
  });

  revalidateAfterAction(ECONOMICS_PATH);
  return { ok: true };
}
