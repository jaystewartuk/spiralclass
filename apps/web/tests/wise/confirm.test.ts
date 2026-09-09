import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirmTransferPayment } from "@/lib/payments/transfer-confirm";

// Unit-level test for the manual Wise confirmation pipeline. Mirrors
// the in-memory-fake style used by webhook.unit.test.ts: a small Prisma
// stand-in lets us assert the side effects (status flip, package
// activation, notification enqueue, override logging, Inngest emits)
// without spinning up a DB.

type FakePayment = {
  id: string;
  status: "pending" | "paid" | "failed" | "refunded";
  amountMinorUnits: number;
  currency: string;
  rail: "card" | "wise" | "unknown";
  provider: "stripe" | "manual_transfer";
  providerPaymentId: string | null;
  paymentReference: string | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  autoMatchedAt: Date | null;
  paidAt: Date | null;
  refundedAt: Date | null;
  package: {
    id: string;
    teacherId: string;
    studentId: string;
    templateId: string | null;
    status: "pending" | "active" | "expired" | "refunded";
  };
};

type FakeNotification = {
  id: string;
  teacherId: string;
  templateName: string;
  paymentId: string | null;
};

type FakeOverride = {
  teacherId: string;
  targetType: string;
  targetId: string;
  action: string;
};

function makeFakePrisma(payment: FakePayment) {
  const notifications: FakeNotification[] = [];
  const overrides: FakeOverride[] = [];

  const fake = {
    payment: {
      findUnique: async (args: any) => {
        if (args.where.id !== payment.id) return null;
        return payment;
      },
      // Backs maybeEmitFirstPayment's post-confirm check (onboarding
      // activation audit) — this suite isn't about that signal, so a
      // fixed count is fine; it just must exist so the injected deps.prisma
      // satisfies Pick<PrismaClient, "payment">.
      count: async () => 1,
      update: async (args: any) => {
        if (args.where.id !== payment.id) throw new Error("not found");
        Object.assign(payment, args.data);
        return payment;
      },
      // Field-guarded flip: only matches while the row still has the status
      // named in the WHERE — mirrors the real conditional updateMany.
      updateMany: async (args: any) => {
        if (args.where.id !== payment.id || payment.status !== args.where.status) {
          return { count: 0 };
        }
        Object.assign(payment, args.data);
        return { count: 1 };
      },
    },
    package: {
      findUnique: async (args: any) => {
        if (args.where.id !== payment.package.id) return null;
        return {
          ...payment.package,
          template: { expirationMonths: 1 },
          teacher: { timezone: "America/Mexico_City" },
        };
      },
      update: async (args: any) => {
        if (args.where.id !== payment.package.id) throw new Error("not found");
        Object.assign(payment.package, args.data);
        return payment.package;
      },
      updateMany: async (args: any) => {
        if (args.where.id !== payment.package.id || payment.package.status !== args.where.status) {
          return { count: 0 };
        }
        Object.assign(payment.package, args.data);
        return { count: 1 };
      },
    },
    notification: {
      create: async ({ data }: any) => {
        const id = `n-${notifications.length + 1}`;
        notifications.push({
          id,
          teacherId: data.teacherId,
          templateName: data.templateName,
          paymentId: data.paymentId ?? null,
        });
        return { id };
      },
    },
    override: {
      create: async ({ data }: any) => {
        overrides.push({
          teacherId: data.teacherId,
          targetType: data.targetType,
          targetId: data.targetId,
          action: data.action,
        });
        return data;
      },
    },
    $transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => fn(fake),
  };

  return { prisma: fake, notifications, overrides };
}

const TEACHER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STUDENT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PACKAGE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PAYMENT_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function freshWisePayment(): FakePayment {
  return {
    id: PAYMENT_ID,
    status: "pending",
    amountMinorUnits: 232_000,
    currency: "MXN",
    rail: "unknown",
    provider: "manual_transfer",
    providerPaymentId: null,
    paymentReference: "AGP-1A2B3C4D",
    confirmedBy: null,
    confirmedAt: null,
    autoMatchedAt: null,
    paidAt: null,
    refundedAt: null,
    package: {
      id: PACKAGE_ID,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      templateId: null,
      status: "pending",
    },
  };
}

const NOW = new Date("2026-05-04T12:00:00Z");

describe("confirmTransferPayment", () => {
  let payment: FakePayment;

  beforeEach(() => {
    payment = freshWisePayment();
  });

  it("flips a pending Wise payment to paid + activates the package + queues notification + records override", async () => {
    const env = makeFakePrisma(payment);
    const emit = vi.fn();
    const outcome = await confirmTransferPayment(
      {
        paymentId: PAYMENT_ID,
        confirmedByTeacherId: TEACHER_ID,
        note: "Recibí en MXN",
      },
      { prisma: env.prisma as any, now: () => NOW, emit },
    );

    expect(outcome.code).toBe("applied");
    expect(payment.status).toBe("paid");
    expect(payment.rail).toBe("wise");
    expect(payment.paidAt).toEqual(NOW);
    expect(payment.confirmedBy).toBe(TEACHER_ID);
    expect(payment.confirmedAt).toEqual(NOW);
    // providerPaymentId is the Stripe PaymentIntent column — Wise rows
    // must leave it null so the admin UI doesn't render Stripe-only
    // controls (the "Stripe ↗" link + refund button).
    expect(payment.providerPaymentId).toBeNull();

    expect(payment.package.status).toBe("active");
    expect(env.notifications).toHaveLength(1);
    expect(env.notifications[0]?.templateName).toBe("payment_received");
    expect(env.overrides).toHaveLength(1);
    expect(env.overrides[0]?.action).toBe("wise_confirm");

    // Two events: notification.queued + payment.paid
    expect(emit).toHaveBeenCalledTimes(2);
    const eventNames = emit.mock.calls.map((c) => c[0].name);
    expect(eventNames).toContain("notification.queued");
    expect(eventNames).toContain("payment.paid");

    // The payload, not just the name. `payment.paid` is the ONLY trigger for
    // auto-book-on-paid, which reads `data.packageId` and nothing else — so a
    // renamed or dropped field here would leave a paid, teacher-confirmed
    // Wise purchase whose class is never booked, while this test stayed green
    // on the event name alone. On the Wise rail that is the whole delivery of
    // what the student bought.
    const paid = emit.mock.calls.map((c) => c[0]).find((e) => e.name === "payment.paid");
    expect(paid?.data).toMatchObject({
      packageId: payment.package.id,
      paymentId: payment.id,
      teacherId: payment.package.teacherId,
      studentId: payment.package.studentId,
    });
  });

  it("records the automated path when confirmedByTeacherId is null", async () => {
    const env = makeFakePrisma(payment);
    const emit = vi.fn();
    const outcome = await confirmTransferPayment(
      { paymentId: PAYMENT_ID, confirmedByTeacherId: null },
      { prisma: env.prisma as any, now: () => NOW, emit },
    );

    expect(outcome.code).toBe("applied");
    expect(payment.status).toBe("paid");
    // Auto path: no teacher, but the auto-matched marker is stamped.
    expect(payment.confirmedBy).toBeNull();
    expect(payment.confirmedAt).toEqual(NOW);
    expect(payment.autoMatchedAt).toEqual(NOW);
    expect(payment.package.status).toBe("active");
    expect(env.overrides[0]?.action).toBe("wise_auto_confirm");

    // The auto path is the one where nobody told the teacher anything: the
    // money lands and the package activates with no human in the loop, so she
    // gets a receipt alongside the student's. (The manual path deliberately
    // does not — see the next test.)
    expect(env.notifications.map((n) => n.templateName).sort()).toEqual([
      "payment_received",
      "payment_received_teacher",
    ]);
    // Both are handed to the dispatcher, not just the student's.
    const queued = emit.mock.calls
      .map(([e]) => e)
      .filter((e: { name: string }) => e.name === "notification.queued");
    expect(queued).toHaveLength(2);
  });

  it("does not notify the teacher when she confirmed the transfer herself", async () => {
    const env = makeFakePrisma(payment);
    const outcome = await confirmTransferPayment(
      { paymentId: PAYMENT_ID, confirmedByTeacherId: TEACHER_ID },
      { prisma: env.prisma as any, now: () => NOW, emit: vi.fn() },
    );

    expect(outcome.code).toBe("applied");
    // She just pressed Confirm — telling her a payment arrived is noise.
    expect(env.notifications.map((n) => n.templateName)).toEqual(["payment_received"]);
  });

  it("refuses to confirm a Stripe payment via this path", async () => {
    payment.provider = "stripe";
    const env = makeFakePrisma(payment);
    const outcome = await confirmTransferPayment(
      { paymentId: PAYMENT_ID, confirmedByTeacherId: TEACHER_ID },
      { prisma: env.prisma as any, now: () => NOW },
    );
    expect(outcome.code).toBe("wrong-provider");
    expect(payment.status).toBe("pending");
    expect(env.notifications).toHaveLength(0);
  });

  it("returns already-paid for a payment that's already been confirmed (idempotent re-click)", async () => {
    payment.status = "paid";
    payment.paidAt = new Date("2026-05-04T10:00:00Z");
    const env = makeFakePrisma(payment);
    const outcome = await confirmTransferPayment(
      { paymentId: PAYMENT_ID, confirmedByTeacherId: TEACHER_ID },
      { prisma: env.prisma as any, now: () => NOW },
    );
    expect(outcome.code).toBe("already-paid");
    expect(env.notifications).toHaveLength(0);
    expect(env.overrides).toHaveLength(0);
  });

  it("returns not-found when the payment id is bogus", async () => {
    const env = makeFakePrisma(payment);
    const outcome = await confirmTransferPayment(
      {
        paymentId: "00000000-0000-0000-0000-000000000000",
        confirmedByTeacherId: TEACHER_ID,
      },
      { prisma: env.prisma as any, now: () => NOW },
    );
    expect(outcome.code).toBe("not-found");
  });

  it("never persists a provider id, even when the Wise reference is missing", async () => {
    payment.paymentReference = null;
    const env = makeFakePrisma(payment);
    const outcome = await confirmTransferPayment(
      { paymentId: PAYMENT_ID, confirmedByTeacherId: TEACHER_ID },
      { prisma: env.prisma as any, now: () => NOW },
    );
    expect(outcome.code).toBe("applied");
    // The synthetic id only satisfies the reducer's typed input; it must
    // not leak into the Stripe-only providerPaymentId column.
    expect(payment.providerPaymentId).toBeNull();
  });

  it("re-activates a superseded (expired) package so paid-for classes aren't stranded", async () => {
    // Regression: the student marked the transfer sent, re-submitted the buy
    // form, and supersede expired package A while the money was in flight.
    // Confirming payment A used to flip it to paid while activatePackage
    // silently no-oped on the expired package — money taken, zero credits.
    payment.package.status = "expired";
    const env = makeFakePrisma(payment);
    const outcome = await confirmTransferPayment(
      { paymentId: PAYMENT_ID, confirmedByTeacherId: TEACHER_ID },
      { prisma: env.prisma as any, now: () => NOW },
    );
    expect(outcome.code).toBe("applied");
    expect(payment.status).toBe("paid");
    expect(payment.package.status).toBe("active");
    expect(env.notifications).toHaveLength(1);
  });

  it("no-ops entirely when a concurrent confirm wins the flip race", async () => {
    // Teacher confirm racing the auto-reconciler: both pass the pre-read
    // status check; the loser's guarded update matches 0 rows and must not
    // double-apply side effects (second override row, second notification,
    // second payment.paid event).
    const env = makeFakePrisma(payment);
    const emit = vi.fn();
    const original = env.prisma.payment.updateMany;
    env.prisma.payment.updateMany = async (args: any) => {
      // The concurrent winner lands between our read and our write.
      payment.status = "paid";
      return original(args);
    };
    const outcome = await confirmTransferPayment(
      { paymentId: PAYMENT_ID, confirmedByTeacherId: TEACHER_ID },
      { prisma: env.prisma as any, now: () => NOW, emit },
    );
    expect(outcome.code).toBe("already-paid");
    expect(payment.package.status).toBe("pending");
    expect(env.notifications).toHaveLength(0);
    expect(env.overrides).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it("survives a noisy emit failure without aborting the DB transition", async () => {
    const env = makeFakePrisma(payment);
    const emit = vi.fn(async () => {
      throw new Error("inngest down");
    });
    const outcome = await confirmTransferPayment(
      { paymentId: PAYMENT_ID, confirmedByTeacherId: TEACHER_ID },
      { prisma: env.prisma as any, now: () => NOW, emit },
    );
    expect(outcome.code).toBe("applied");
    expect(payment.status).toBe("paid");
    // emit was attempted both times; the catch swallowed the error.
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
