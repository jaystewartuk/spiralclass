"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { transferConfirmSchema } from "@/lib/validators";
import { confirmTransferPayment } from "@/lib/payments/transfer-confirm";
import { getPreferredLocale } from "@/lib/i18n";
import { enqueueEvent } from "@/lib/jobs/enqueue";
import { flushAnalytics } from "@/lib/analytics/posthog";

// Teacher action: marks a Wise-pending payment as received.
//
// Authorization:
//   * `requireOnboardedTeacher` ensures we have a logged-in teacher.
//   * The Payment lookup filters by `package.teacherId = teacher.id` so a
//     teacher cannot confirm someone else's row.
//
// Side effects (delegated to confirmTransferPayment): activates the package,
// enqueues the payment_received notification, emits Inngest events,
// records an `overrides` audit row.
export async function confirmTransferPaymentAction(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const parsed = transferConfirmSchema(locale).safeParse({
    paymentId: formData.get("paymentId"),
    note: formData.get("note"),
  });
  if (!parsed.success) {
    redirect("/payments?error=missing-fields");
  }
  const input = parsed.data;

  // Tenancy guard: only the teacher who owns the package can confirm.
  const owns = await prisma.payment.findFirst({
    where: { id: input.paymentId, package: { teacherId: teacher.id } },
    select: { id: true },
  });
  if (!owns) {
    redirect("/payments?error=missing-payment");
  }

  const outcome = await confirmTransferPayment(
    {
      paymentId: input.paymentId,
      confirmedByTeacherId: teacher.id,
      note: input.note,
    },
    {
      prisma,
      emit: (event) => enqueueEvent(event),
    },
  );

  if (outcome.code === "wrong-provider") {
    redirect(`/payments/${input.paymentId}?error=not-wise`);
  }
  if (outcome.code === "not-found") {
    redirect("/payments?error=missing-payment");
  }
  // Already-paid / already-refunded / already-failed: silently re-render
  // the detail page. The teacher just sees the current state without an
  // error toast — clicking again on a stale tab shouldn't punish them.

  revalidatePath(`/payments/${input.paymentId}`);
  revalidatePath("/payments");
  // confirmTransferPayment fires payment_received on this success path; drain it
  // before the redirect throws (this action never flushed before).
  await flushAnalytics();
  redirect(`/payments/${input.paymentId}?wise_confirmed=1`);
}

// Teacher action: marks a Wise-pending payment as failed (e.g. student
// said they wouldn't pay after all). Hard-deletes the package via the
// normal cleanup path is too aggressive — we just transition Payment +
// Package to a terminal state so the row stops cluttering the pending
// queue and the cleanup cron skips it.
export async function failWisePaymentAction(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = transferConfirmSchema(locale).safeParse({
    paymentId: formData.get("paymentId"),
    note: formData.get("note"),
  });
  if (!parsed.success) {
    redirect("/payments?error=missing-fields");
  }
  const input = parsed.data;

  const payment = await prisma.payment.findFirst({
    where: { id: input.paymentId, package: { teacherId: teacher.id } },
    include: { package: { select: { id: true, status: true } } },
  });
  if (!payment) {
    redirect("/payments?error=missing-payment");
  }
  if (payment.provider !== "manual_transfer") {
    redirect(`/payments/${input.paymentId}?error=not-wise`);
  }
  if (payment.status !== "pending") {
    redirect(`/payments/${input.paymentId}?error=not-pending`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: "failed" },
    });
    // The package was created in `pending` and still is — flipping the
    // package row to `expired` keeps the booking surface from offering
    // it as a usable package without losing the audit trail. We
    // intentionally do NOT delete; the cleanup cron handles that path.
    if (payment.package.status === "pending") {
      await tx.package.update({
        where: { id: payment.package.id },
        data: { status: "expired" },
      });
    }
    await tx.override.create({
      data: {
        teacherId: teacher.id,
        targetType: "payment",
        targetId: payment.id,
        action: "wise_fail",
        reason: input.note ?? (en ? "Wise: payment not received" : "Wise: pago no recibido"),
        beforeJson: { status: "pending" },
        afterJson: { status: "failed" },
      },
    });
  });

  revalidatePath(`/payments/${input.paymentId}`);
  revalidatePath("/payments");
  redirect(`/payments/${input.paymentId}?wise_failed=1`);
}
