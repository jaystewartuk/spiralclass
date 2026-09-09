import type { PrismaClient } from "@prisma/client";
import {
  enqueuePaymentMarkedSentTeacher,
  enqueueWiseMarkedSentStudent,
} from "@/lib/notifications/enqueue";

// Records that a student clicked "Ya envié el pago" on the transfer
// instructions page. Idempotent — repeated clicks are a no-op, so a
// student who double-taps doesn't double-notify anyone. First click
// queues two rows: the teacher nudge and the student acknowledgment
// ("we told your teacher; the package activates when she confirms").
//
// Returns the externalReference for the caller to use in the redirect
// to /b/<slug>/buy/result?ref=<externalReference>.

export type MarkTransferSentDeps = {
  prisma: Pick<PrismaClient, "payment" | "$transaction" | "notification">;
  now?: () => Date;
};

export type MarkTransferSentInput = {
  slug: string;
  paymentReference: string;
};

export type MarkTransferSentOutcome =
  | { code: "not-found" }
  | { code: "wrong-provider" }
  | { code: "already-paid"; externalReference: string }
  | {
      code: "marked" | "already-marked";
      externalReference: string;
      paymentId: string;
      teacherId: string;
      notificationIds: string[];
    };

export async function markTransferSent(
  input: MarkTransferSentInput,
  deps: MarkTransferSentDeps,
): Promise<MarkTransferSentOutcome> {
  const payment = await deps.prisma.payment.findFirst({
    where: {
      paymentReference: input.paymentReference,
      package: { teacher: { bookingSlug: input.slug } },
    },
    select: {
      id: true,
      status: true,
      provider: true,
      externalReference: true,
      studentMarkedSentAt: true,
      package: { select: { teacherId: true, studentId: true } },
    },
  });
  if (!payment) return { code: "not-found" };
  if (payment.provider !== "manual_transfer") return { code: "wrong-provider" };
  if (payment.status === "paid" || payment.status === "refunded") {
    return { code: "already-paid", externalReference: payment.externalReference };
  }
  if (payment.studentMarkedSentAt) {
    return {
      code: "already-marked",
      externalReference: payment.externalReference,
      paymentId: payment.id,
      teacherId: payment.package.teacherId,
      notificationIds: [],
    };
  }

  const now = (deps.now ?? (() => new Date()))();
  const notificationIds = await deps.prisma.$transaction(async (tx) => {
    // Race-safe idempotency: only flip + enqueue when the column is still
    // null. A second concurrent click sees `count: 0` and returns nothing.
    const updated = await tx.payment.updateMany({
      where: { id: payment.id, studentMarkedSentAt: null },
      data: { studentMarkedSentAt: now },
    });
    if (updated.count === 0) return [];
    const teacherNoticeId = await enqueuePaymentMarkedSentTeacher(tx, {
      teacherId: payment.package.teacherId,
      paymentId: payment.id,
    });
    const studentAckId = await enqueueWiseMarkedSentStudent(tx, {
      teacherId: payment.package.teacherId,
      studentId: payment.package.studentId,
      paymentId: payment.id,
    });
    return [teacherNoticeId, studentAckId];
  });

  return {
    code: notificationIds.length > 0 ? "marked" : "already-marked",
    externalReference: payment.externalReference,
    paymentId: payment.id,
    teacherId: payment.package.teacherId,
    notificationIds,
  };
}
