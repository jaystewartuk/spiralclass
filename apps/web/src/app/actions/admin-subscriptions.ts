"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { writeOverride } from "@/lib/audit";
import { lockedPriceForPlan } from "@/lib/subscriptions/service";
import { activateSubscription, recordSubscriptionInvoice } from "@/lib/subscriptions/lifecycle";
import { inngest } from "@/lib/inngest/client";
import type { LifecycleEmitter } from "@/lib/subscriptions/lifecycle";

const emit: LifecycleEmitter = async (event) => {
  await inngest.send(event);
};

export type AdminSubscriptionState = { error?: string; ok?: boolean } | undefined;

// Comp a teacher's subscription (full Pro, never billed) — e.g. the founding
// customer. Finance role. Idempotent.
const compSchema = z.object({
  teacherId: z.string().uuid(),
  plan: z.enum(["monthly", "annual", "founding"]).default("founding"),
  reason: z.string().trim().max(280).optional(),
});

export async function markSubscriptionComped(
  _prev: AdminSubscriptionState,
  formData: FormData,
): Promise<AdminSubscriptionState> {
  const actor = await requireAdmin("finance");
  const parsed = compSchema.safeParse({
    teacherId: formData.get("teacherId"),
    plan: formData.get("plan") ?? "founding",
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) return { error: "Invalid input" };

  const before = await prisma.teacherSubscription.findUnique({
    where: { teacherId: parsed.data.teacherId },
    select: { plan: true, comped: true, currency: true },
  });

  await activateSubscription(
    { prisma, emit },
    {
      teacherId: parsed.data.teacherId,
      plan: parsed.data.plan,
      // Preserve the teacher's existing billing currency (a pre-D-99 MXN
      // subscriber comped today must not get silently relabeled GBP); only a
      // brand-new row falls through to lockedPriceForPlan's canonical default.
      lockedPriceMinorUnits: lockedPriceForPlan(parsed.data.plan, before?.currency),
      currency: before?.currency,
      comped: true,
    },
  );
  await writeOverride({
    teacherId: parsed.data.teacherId,
    targetType: "teacher",
    targetId: parsed.data.teacherId,
    action: "comp_subscription",
    reason: parsed.data.reason ?? "(no reason provided)",
    before: before ?? null,
    after: { plan: parsed.data.plan, comped: true },
    actor,
  });
  revalidatePath("/admin/subscriptions");
  revalidatePath(`/admin/teachers/${parsed.data.teacherId}`);
  return { ok: true };
}

// Manual subscription payment, for a teacher who pays by transfer rather than
// by card. An admin marks a billing cycle paid: this records a
// `provider: "manual"` invoice and activates the subscription.
//
// It is deliberately the whole rail. The invoice schema is rail-agnostic
// (`provider` + `manualPaymentRef`), so automating it would add a reconciler
// and change no schema — which is why nothing is stubbed out in advance here.
// Adding the automated half is its own decision, and this repository does not
// carry forward-looking work (D-110).
const manualPaidSchema = z.object({
  teacherId: z.string().uuid(),
  plan: z.enum(["monthly", "annual", "founding"]),
  amountMinorUnits: z.coerce.number().int().min(0),
  manualPaymentRef: z.string().trim().max(120).optional(),
  reason: z.string().trim().max(280).optional(),
});

export async function markSubscriptionPaidManually(
  _prev: AdminSubscriptionState,
  formData: FormData,
): Promise<AdminSubscriptionState> {
  const actor = await requireAdmin("finance");
  const parsed = manualPaidSchema.safeParse({
    teacherId: formData.get("teacherId"),
    plan: formData.get("plan"),
    amountMinorUnits: formData.get("amountMinorUnits"),
    manualPaymentRef: formData.get("manualPaymentRef") ?? undefined,
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) return { error: "Invalid input" };

  const before = await prisma.teacherSubscription.findUnique({
    where: { teacherId: parsed.data.teacherId },
    select: { plan: true, status: true, currency: true },
  });

  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  await recordSubscriptionInvoice(
    { prisma, emit },
    {
      teacherId: parsed.data.teacherId,
      amountMinorUnits: parsed.data.amountMinorUnits,
      // Manual/Wise: the platform's Stripe fee is 0 (paid by transfer); net =
      // amount. The commission base reads this net directly.
      feeMinorUnits: 0,
      currency: before?.currency,
      periodStart: now,
      periodEnd,
      status: "paid",
      provider: "manual",
      manualPaymentRef: parsed.data.manualPaymentRef ?? null,
      paidAt: now,
    },
  );
  await activateSubscription(
    { prisma, emit },
    {
      teacherId: parsed.data.teacherId,
      plan: parsed.data.plan,
      // The admin-submitted amount (prefilled from the teacher's OWN locked
      // price — see WiseRenewalForm) IS the renewal price. Re-deriving it from
      // lockedPriceForPlan(plan) instead would silently reprice a
      // pre-D-99 MXN subscriber to the current GBP config price on every
      // manual renewal — never re-derive a locked price once one exists.
      lockedPriceMinorUnits: parsed.data.amountMinorUnits,
      currency: before?.currency,
      currentPeriodEnd: periodEnd,
    },
  );
  await writeOverride({
    teacherId: parsed.data.teacherId,
    targetType: "teacher",
    targetId: parsed.data.teacherId,
    action: "mark_subscription_paid_manually",
    reason: parsed.data.reason ?? "(no reason provided)",
    before: before ?? null,
    after: {
      plan: parsed.data.plan,
      amountMinorUnits: parsed.data.amountMinorUnits,
      manualPaymentRef: parsed.data.manualPaymentRef ?? null,
    },
    actor,
  });
  revalidatePath("/admin/subscriptions");
  revalidatePath(`/admin/teachers/${parsed.data.teacherId}`);
  return { ok: true };
}
