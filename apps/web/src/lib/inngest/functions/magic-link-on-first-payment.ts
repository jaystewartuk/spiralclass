import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { enqueueMagicLink } from "@/lib/notifications/enqueue";
import { emitNotificationQueued } from "@/lib/notifications/events";

// CLAUDE.md "Known gaps" closure: after a paid checkout, send the student a
// notification whose button (dispatcher.ts's "magic_link" template) resolves
// to `/r/ml/<notificationId>` — a redirect router that mints a real
// server-trusted sign-in session at click time (lib/auth/server-otp.ts,
// D-40) — so they reach `/my-classes` without re-entering their email. Slice
// 3 enqueues `payment_received`; this function adds the magic-link-handoff
// that was previously listed as a known gap.
//
// Only fires on the first `payment.paid` for a student on a given teacher —
// repeat payments skip so returning students don't get sign-in links they
// don't need.

// Exported for unit testing. `step` is typed structurally so the handler can
// be driven with a fake step runner in tests.
type StepRunner = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };

export async function magicLinkOnFirstPaymentHandler({
  event,
  step,
}: {
  event: { data: unknown };
  step: StepRunner;
}) {
  const { paymentId, teacherId, studentId } = event.data as {
    paymentId: string;
    teacherId: string;
    studentId: string;
  };

  return await step.run("mint-and-enqueue", async () => {
    // Tenant isolation: explicit teacher filter. Also check "first payment" by
    // looking for any prior paid Payment for this teacher+student.
    const payment = await prisma.payment.findFirst({
      where: {
        id: paymentId,
        package: { teacherId, studentId },
      },
      select: { id: true, package: { select: { teacherId: true, studentId: true } } },
    });
    if (!payment) return { skipped: "payment-not-found" };

    const priorPaid = await prisma.payment.count({
      where: {
        id: { not: paymentId },
        status: "paid",
        package: { teacherId, studentId },
      },
    });
    if (priorPaid > 0) return { skipped: "not-first-payment" };

    // Guard the count race: two near-simultaneous `payment.paid` deliveries
    // (Stripe + Wise, or a retried event) can both observe priorPaid === 0.
    // If a magic-link handoff was already created for this teacher+student,
    // don't mint a second one. (The first-payment handoff is one-per-pair.)
    const existingLink = await prisma.notification.findFirst({
      where: {
        teacherId,
        recipientType: "student",
        recipientId: studentId,
        templateName: "magic_link",
      },
      select: { id: true },
    });
    if (existingLink) return { skipped: "magic-link-already-sent" };

    const student = await prisma.student.findFirst({
      where: {
        id: studentId,
        teacherStudents: { some: { teacherId } },
      },
      select: { email: true },
    });
    if (!student?.email) return { skipped: "student-has-no-email" };

    // dispatcher.ts's "magic_link" template builds the actual send target
    // from the notification's own id (`r/ml/<id>`), never from this stored
    // URL — it's only a presence marker (see MagicLinkMetadata / the
    // "missing-metadata:magicLinkUrl" gate). No minting needed here anymore
    // now that /r/ml mints its own session at click time.
    const notificationId = await enqueueMagicLink(prisma, {
      teacherId,
      studentId,
      magicLinkUrl: `/r/ml/pending`,
      expiryMinutes: 60,
      paymentId,
    });
    await emitNotificationQueued({ notificationId, teacherId });
    return { sent: true, notificationId };
  });
}

export const magicLinkOnFirstPaymentFn = inngest.createFunction(
  {
    id: "magic-link-on-first-payment",
    retries: 2,
    triggers: [{ event: "payment.paid" }],
  },
  magicLinkOnFirstPaymentHandler,
);
