import { describe, expect, it } from "vitest";
import { markTransferSent } from "@/lib/payments/mark-transfer-sent";

// Mirrors the deps shape that the helper actually uses (Pick<…>). The
// test harness models the tiny slice of behavior we depend on:
//   * payment.findFirst — returns a single row matching slug + ref
//   * $transaction — runs the callback once with a tx that exposes
//     payment.updateMany (race-safe update) + notification.create
// No real DB — keeps the test deterministic and side-effect free.

type PaymentRow = {
  id: string;
  status: "pending" | "paid" | "refunded";
  provider: "stripe" | "manual_transfer";
  externalReference: string;
  paymentReference: string | null;
  studentMarkedSentAt: Date | null;
  package: { teacherId: string; studentId: string };
  bookingSlug: string;
};

function makeFakePrisma(rows: PaymentRow[]) {
  const notifications: { id: string; data: Record<string, unknown> }[] = [];
  let notifSeq = 0;
  const prisma = {
    payment: {
      findFirst: async ({
        where,
      }: {
        where: { paymentReference: string; package: { teacher: { bookingSlug: string } } };
      }) => {
        const row = rows.find(
          (r) =>
            r.paymentReference === where.paymentReference &&
            r.bookingSlug === where.package.teacher.bookingSlug,
        );
        if (!row) return null;
        return {
          id: row.id,
          status: row.status,
          provider: row.provider,
          externalReference: row.externalReference,
          studentMarkedSentAt: row.studentMarkedSentAt,
          package: {
            teacherId: row.package.teacherId,
            studentId: row.package.studentId,
          },
        };
      },
    },
    notification: {} as never,
    $transaction: async (fn: (tx: unknown) => Promise<string[]>) => {
      const tx = {
        payment: {
          updateMany: async ({
            where,
            data,
          }: {
            where: { id: string; studentMarkedSentAt: null };
            data: { studentMarkedSentAt: Date };
          }) => {
            const row = rows.find((r) => r.id === where.id);
            if (!row || row.studentMarkedSentAt !== null) return { count: 0 };
            row.studentMarkedSentAt = data.studentMarkedSentAt;
            return { count: 1 };
          },
        },
        notification: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const id = `notif-${++notifSeq}`;
            notifications.push({ id, data });
            return { id };
          },
        },
      };
      return fn(tx);
    },
  };
  return { prisma, notifications };
}

const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STUDENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("markTransferSent", () => {
  it("flips studentMarkedSentAt and enqueues the teacher nudge + student ack first time", async () => {
    const { prisma, notifications } = makeFakePrisma([
      {
        id: "pay-1",
        status: "pending",
        provider: "manual_transfer",
        externalReference: "ext-1",
        paymentReference: "AGP-AAAA1111",
        studentMarkedSentAt: null,
        package: { teacherId: TEACHER_ID, studentId: STUDENT_ID },
        bookingSlug: "mira",
      },
    ]);
    const now = new Date("2026-05-26T21:00:00Z");

    const outcome = await markTransferSent(
      { slug: "mira", paymentReference: "AGP-AAAA1111" },
      { prisma: prisma as never, now: () => now },
    );

    expect(outcome).toMatchObject({
      code: "marked",
      externalReference: "ext-1",
      paymentId: "pay-1",
      teacherId: TEACHER_ID,
    });
    expect(outcome.code === "marked" && outcome.notificationIds).toEqual(["notif-1", "notif-2"]);
    expect(notifications).toHaveLength(2);
    expect(notifications[0].data).toMatchObject({
      teacherId: TEACHER_ID,
      recipientType: "teacher",
      recipientId: TEACHER_ID,
      paymentId: "pay-1",
      channel: "email",
      templateName: "payment_marked_sent_teacher",
      status: "queued",
    });
    expect(notifications[1].data).toMatchObject({
      teacherId: TEACHER_ID,
      recipientType: "student",
      recipientId: STUDENT_ID,
      paymentId: "pay-1",
      templateName: "wise_marked_sent_student",
      status: "queued",
    });
  });

  it("is idempotent — a re-click does not re-enqueue", async () => {
    const alreadyMarkedAt = new Date("2026-05-26T20:00:00Z");
    const { prisma, notifications } = makeFakePrisma([
      {
        id: "pay-1",
        status: "pending",
        provider: "manual_transfer",
        externalReference: "ext-1",
        paymentReference: "AGP-AAAA1111",
        studentMarkedSentAt: alreadyMarkedAt,
        package: { teacherId: TEACHER_ID, studentId: STUDENT_ID },
        bookingSlug: "mira",
      },
    ]);

    const outcome = await markTransferSent(
      { slug: "mira", paymentReference: "AGP-AAAA1111" },
      { prisma: prisma as never },
    );

    expect(outcome).toMatchObject({
      code: "already-marked",
      externalReference: "ext-1",
      notificationIds: [],
    });
    expect(notifications).toHaveLength(0);
  });

  it("returns already-paid when the teacher already confirmed", async () => {
    const { prisma } = makeFakePrisma([
      {
        id: "pay-1",
        status: "paid",
        provider: "manual_transfer",
        externalReference: "ext-1",
        paymentReference: "AGP-AAAA1111",
        studentMarkedSentAt: null,
        package: { teacherId: TEACHER_ID, studentId: STUDENT_ID },
        bookingSlug: "mira",
      },
    ]);
    const outcome = await markTransferSent(
      { slug: "mira", paymentReference: "AGP-AAAA1111" },
      { prisma: prisma as never },
    );
    expect(outcome).toEqual({ code: "already-paid", externalReference: "ext-1" });
  });

  it("returns not-found for unknown reference", async () => {
    const { prisma } = makeFakePrisma([]);
    const outcome = await markTransferSent(
      { slug: "mira", paymentReference: "AGP-NOPE" },
      { prisma: prisma as never },
    );
    expect(outcome).toEqual({ code: "not-found" });
  });

  it("rejects non-Wise payments (defense in depth — should never happen)", async () => {
    const { prisma } = makeFakePrisma([
      {
        id: "pay-1",
        status: "pending",
        provider: "stripe",
        externalReference: "ext-1",
        paymentReference: "AGP-AAAA1111",
        studentMarkedSentAt: null,
        package: { teacherId: TEACHER_ID, studentId: STUDENT_ID },
        bookingSlug: "mira",
      },
    ]);
    const outcome = await markTransferSent(
      { slug: "mira", paymentReference: "AGP-AAAA1111" },
      { prisma: prisma as never },
    );
    expect(outcome).toEqual({ code: "wrong-provider" });
  });
});
