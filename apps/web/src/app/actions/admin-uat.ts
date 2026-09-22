"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { writeOverride } from "@/lib/audit";
import { enqueue } from "@/lib/jobs/enqueue";
import { runUatProbe } from "@/lib/uat/probe";
import { runPostHogCheck } from "@/lib/uat/posthog-check";
import { runStripeCheck } from "@/lib/uat/stripe-check";
import { assertReseedAllowed, UAT_OVERRIDE_TARGET_IDS } from "@/lib/uat/env-targets";
import { revalidateAfterAction } from "@/lib/revalidate";

export type UatActionState = { error?: string; result?: unknown } | undefined;

const envSchema = z.enum(["preview", "production"]);

export async function runUatProbeAction(
  _prev: UatActionState,
  formData: FormData,
): Promise<UatActionState> {
  const actor = await requireAdmin("superadmin", "uat:run");
  const parsed = envSchema.safeParse(formData.get("env"));
  if (!parsed.success) return { error: "Invalid environment" };

  const report = await runUatProbe(parsed.data);
  await writeOverride({
    teacherId: null,
    targetType: "system",
    targetId: UAT_OVERRIDE_TARGET_IDS.probe,
    action: "run_uat_probe",
    reason: `env=${parsed.data}`,
    after: report,
    actor,
  });
  revalidateAfterAction("/admin/uat");
  return { result: report };
}

export async function runPostHogCheckAction(
  _prev: UatActionState,
  formData: FormData,
): Promise<UatActionState> {
  const actor = await requireAdmin("superadmin", "uat:run");
  const parsed = envSchema.safeParse(formData.get("env"));
  if (!parsed.success) return { error: "Invalid environment" };

  const report = await runPostHogCheck(parsed.data);
  await writeOverride({
    teacherId: null,
    targetType: "system",
    targetId: UAT_OVERRIDE_TARGET_IDS.posthogCheck,
    action: "run_uat_posthog_check",
    reason: `env=${parsed.data}`,
    after: report,
    actor,
  });
  revalidateAfterAction("/admin/uat");
  return { result: report };
}

const stripeCheckSchema = z.object({
  env: envSchema,
  studentEmail: z.string().trim().email().optional().or(z.literal("")),
  paymentId: z.string().uuid().optional().or(z.literal("")),
});

export async function runStripeCheckAction(
  _prev: UatActionState,
  formData: FormData,
): Promise<UatActionState> {
  const actor = await requireAdmin("superadmin", "uat:run");
  const parsed = stripeCheckSchema.safeParse({
    env: formData.get("env"),
    studentEmail: formData.get("studentEmail") || undefined,
    paymentId: formData.get("paymentId") || undefined,
  });
  if (!parsed.success) return { error: "Invalid input" };

  const report = await runStripeCheck(parsed.data.env, {
    studentEmail: parsed.data.studentEmail || undefined,
    paymentId: parsed.data.paymentId || undefined,
  });
  await writeOverride({
    teacherId: null,
    targetType: "system",
    targetId: UAT_OVERRIDE_TARGET_IDS.stripeCheck,
    action: "run_uat_stripe_check",
    reason: `env=${parsed.data.env} student=${parsed.data.studentEmail ?? ""} payment=${parsed.data.paymentId ?? ""}`,
    after: report,
    actor,
  });
  revalidateAfterAction("/admin/uat");
  return { result: report };
}

// Same bulk-volume knobs as the CLI's SEED_BULK_TEACHERS/
// SEED_BULK_STUDENTS_PER_TEACHER env vars (scripts/seed.ts's main()).
// Bounded (unlike the CLI, which trusts whoever set the env var) since this
// is a public form in a UI — a fat-fingered huge number would just run a
// very long Inngest job for no benefit.
const reseedSchema = z.object({
  env: envSchema,
  bulkTeachers: z.coerce.number().int().min(0).max(200).default(0),
  studentsPerBulkTeacher: z.coerce.number().int().min(0).max(50).default(6),
});

export async function reseedPreviewAction(
  _prev: UatActionState,
  formData: FormData,
): Promise<UatActionState> {
  const actor = await requireAdmin("superadmin", "uat:run");
  const parsed = reseedSchema.safeParse({
    env: formData.get("env"),
    bulkTeachers: formData.get("bulkTeachers") || undefined,
    studentsPerBulkTeacher: formData.get("studentsPerBulkTeacher") || undefined,
  });
  if (!parsed.success) return { error: "Invalid input" };

  try {
    assertReseedAllowed(parsed.data.env);
  } catch (err) {
    return { error: (err as Error).message };
  }

  const queuedAt = new Date();
  await enqueue("admin/uat.reseed-preview", {
    requestedByAdminId: actor.id,
    bulkTeachers: parsed.data.bulkTeachers,
    studentsPerBulkTeacher: parsed.data.studentsPerBulkTeacher,
  });
  await writeOverride({
    teacherId: null,
    targetType: "system",
    targetId: UAT_OVERRIDE_TARGET_IDS.reseedPreview,
    action: "queue_reseed_preview",
    reason: `queued from /admin/uat (bulkTeachers=${parsed.data.bulkTeachers}, studentsPerBulkTeacher=${parsed.data.studentsPerBulkTeacher})`,
    actor,
  });
  revalidateAfterAction("/admin/uat");
  return { result: { queued: true, queuedAt: queuedAt.toISOString() } };
}

export type ReseedStatus =
  | { status: "running" }
  | { status: "completed"; summary: { teachers: number; students: number } }
  | { status: "failed"; error: string };

// Polled from the client after reseedPreviewAction queues the job — the seed
// itself runs in a separate Inngest invocation, so this just checks whether a
// newer completion/failure audit row has landed yet.
export async function getReseedStatusAction(queuedAtIso: string): Promise<ReseedStatus> {
  await requireAdmin("superadmin", "uat:run");
  const since = new Date(queuedAtIso);
  const row = await prisma.override.findFirst({
    where: {
      targetId: UAT_OVERRIDE_TARGET_IDS.reseedPreview,
      createdAt: { gt: since },
      action: { in: ["reseed_preview_completed", "reseed_preview_failed"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return { status: "running" };
  if (row.action === "reseed_preview_failed") {
    return { status: "failed", error: row.reason };
  }
  const after = row.afterJson as { teachers?: number; students?: number } | null;
  return {
    status: "completed",
    summary: { teachers: after?.teachers ?? 0, students: after?.students ?? 0 },
  };
}

const clearChecklistSchema = z.object({ env: envSchema });

// "Start again" — wipes the checked-items state for one environment so a
// fresh UAT run doesn't inherit ticks from the last one. Scoped to a single
// env; the other env's progress is untouched.
export async function clearUatChecklistAction(
  _prev: UatActionState,
  formData: FormData,
): Promise<UatActionState> {
  const actor = await requireAdmin("superadmin", "uat:run");
  const parsed = clearChecklistSchema.safeParse({ env: formData.get("env") });
  if (!parsed.success) return { error: "Invalid input" };

  await prisma.uatChecklistState.upsert({
    where: { targetEnv: parsed.data.env },
    create: { targetEnv: parsed.data.env, checkedItems: [], updatedByAdminId: actor.id },
    update: { checkedItems: [], updatedByAdminId: actor.id },
  });
  await writeOverride({
    teacherId: null,
    targetType: "system",
    targetId: UAT_OVERRIDE_TARGET_IDS.clearChecklist,
    action: "clear_uat_checklist",
    reason: `env=${parsed.data.env}`,
    actor,
  });
  revalidateAfterAction("/admin/uat");
  return { result: { ok: true } };
}

const toggleSchema = z.object({
  env: envSchema,
  itemKey: z.string().min(1),
  checked: z.enum(["true", "false"]),
});

export async function toggleUatChecklistItemAction(
  _prev: UatActionState,
  formData: FormData,
): Promise<UatActionState> {
  const actor = await requireAdmin("superadmin", "uat:run");
  const parsed = toggleSchema.safeParse({
    env: formData.get("env"),
    itemKey: formData.get("itemKey"),
    checked: formData.get("checked"),
  });
  if (!parsed.success) return { error: "Invalid input" };

  const existing = await prisma.uatChecklistState.findUnique({
    where: { targetEnv: parsed.data.env },
    select: { checkedItems: true },
  });
  const current = new Set(
    Array.isArray(existing?.checkedItems) ? (existing.checkedItems as string[]) : [],
  );
  if (parsed.data.checked === "true") current.add(parsed.data.itemKey);
  else current.delete(parsed.data.itemKey);

  await prisma.uatChecklistState.upsert({
    where: { targetEnv: parsed.data.env },
    create: {
      targetEnv: parsed.data.env,
      checkedItems: [...current],
      updatedByAdminId: actor.id,
    },
    update: {
      checkedItems: [...current],
      updatedByAdminId: actor.id,
    },
  });
  revalidateAfterAction("/admin/uat");
  return { result: { ok: true } };
}
