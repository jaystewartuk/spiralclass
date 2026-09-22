"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { markTransferSent } from "@/lib/payments/mark-transfer-sent";
import { emitNotificationQueued } from "@/lib/notifications/events";

// Student clicks "Ya envié el pago" on the Wise instructions page. We
// record the click (idempotent), notify the teacher the first time, and
// redirect to the polling result page. Failures fall through to the
// redirect — we never want this button to leave the student on a broken
// state.

const schema = z.object({
  slug: z.string().min(1),
  ref: z.string().min(1),
});

export async function markTransferPaymentSentAction(formData: FormData): Promise<void> {
  const parsed = schema.safeParse({
    slug: formData.get("slug"),
    ref: formData.get("ref"),
  });
  if (!parsed.success) {
    // Caller probably tampered with hidden fields. Send them home.
    redirect("/");
  }
  const { slug, ref } = parsed.data;
  const outcome = await markTransferSent({ slug, paymentReference: ref }, { prisma });

  if (outcome.code === "not-found" || outcome.code === "wrong-provider") {
    redirect(`/b/${slug}/buy/wise/${ref}`);
  }

  if (outcome.code === "marked") {
    for (const notificationId of outcome.notificationIds) {
      await emitNotificationQueued({
        notificationId,
        teacherId: outcome.teacherId,
      });
    }
  }

  redirect(`/b/${slug}/buy/result?ref=${outcome.externalReference}`);
}
