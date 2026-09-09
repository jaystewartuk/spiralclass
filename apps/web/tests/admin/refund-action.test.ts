import { beforeEach, describe, expect, it, vi } from "vitest";

// Admin-initiated refund flow:
//   1. requireAdmin("finance") allows the call (mocked).
//   2. Stripe createRefund is called with the payment_intent id. Under direct
//      charges (D-143) that debits the TEACHER's own balance, so there is no
//      platform-held transfer to claw back afterwards.
//   3. In one transaction: payment → refunded, package → refunded,
//      Override row written with actor + reason + before/after, the referral
//      reward voided, and BOTH parties notified.
//
// The last two are `applyRefund`, shared with the teacher-facing action. This
// path had neither: an admin refund left a referrer holding a live reward for
// a purchase that had been given back, and told nobody — least of all the
// student whose money moved — that it had happened. It also flipped without
// the `status: "paid"` guard, so two concurrent refunds could both audit.

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const PAYMENT_ID = "22222222-2222-4222-8222-222222222222";
const PACKAGE_ID = "33333333-3333-4333-8333-333333333333";
const TEACHER_ID = "44444444-4444-4444-8444-444444444444";
const STUDENT_ID = "55555555-5555-4555-8555-555555555555";
const PAYMENT_INTENT_ID = "pi_test_abc";
const REFUND_ID = "re_test_xyz";

type PaymentRow = {
  id: string;
  status: string;
  provider: string;
  providerPaymentId: string | null;
  refundedAt: Date | null;
  refundProviderId: string | null;
  package: {
    id: string;
    teacherId: string;
    studentId: string;
    // D-143: the admin refund is issued AS the teacher, so her connected
    // account travels with the payment row.
    teacher: { stripeAccountId: string | null };
  };
};

type PackageRow = { id: string; status: string };

type NotificationRow = {
  templateName: string;
  recipientType: string;
  recipientId: string;
  paymentId: string;
};

type OverrideRow = {
  teacherId: string;
  targetType: string;
  targetId: string;
  action: string;
  reason: string;
  beforeJson: unknown;
  afterJson: unknown;
  actorAdminId: string | null;
};

const state: {
  payment: PaymentRow;
  package: PackageRow;
  overrides: OverrideRow[];
  notifications: NotificationRow[];
} = {
  payment: {
    id: PAYMENT_ID,
    status: "paid",
    provider: "stripe",
    providerPaymentId: PAYMENT_INTENT_ID,
    refundedAt: null,
    refundProviderId: null,
    package: {
      id: PACKAGE_ID,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      teacher: { stripeAccountId: "acct_teacher_1" },
    },
  },
  package: { id: PACKAGE_ID, status: "active" },
  overrides: [],
  notifications: [],
};

function freshState() {
  state.payment = {
    id: PAYMENT_ID,
    status: "paid",
    provider: "stripe",
    providerPaymentId: PAYMENT_INTENT_ID,
    refundedAt: null,
    refundProviderId: null,
    package: {
      id: PACKAGE_ID,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      teacher: { stripeAccountId: "acct_teacher_1" },
    },
  };
  state.package = { id: PACKAGE_ID, status: "active" };
  state.overrides = [];
  state.notifications = [];
}

const createRefundMock = vi.fn(async () => ({ id: REFUND_ID }));
const captureExceptionMock = vi.fn();
const revalidatePathMock = vi.fn();

vi.mock("@/lib/admin", () => ({
  BOOTSTRAP_ACTOR_ID: "00000000-0000-0000-0000-000000000000",
  requireAdmin: vi.fn(async () => ({
    id: ADMIN_ID,
    email: "admin@example.com",
    role: "finance",
  })),
  isBootstrapActor: (a: { id: string }) => a.id === "00000000-0000-0000-0000-000000000000",
}));

vi.mock("@/lib/stripe", () => ({
  getStripeClient: () => ({
    createRefund: createRefundMock,
  }),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: captureExceptionMock }));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

// Reaches the jobs backend (and serverEnv) at import time; the enqueue
// producers themselves run for real against the tx stub below.
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued: vi.fn(async () => {}) }));

vi.mock("@/lib/prisma", async () => {
  const { Prisma } = await import("@prisma/client");
  const tx = {
    payment: {
      update: async ({ where, data }: { where: { id: string }; data: Partial<PaymentRow> }) => {
        if (where.id !== state.payment.id) throw new Error("wrong payment id");
        Object.assign(state.payment, data);
        return state.payment;
      },
      // applyRefund flips through a guarded updateMany so a concurrent second
      // refund matches nothing instead of duplicating the audit row.
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: string };
        data: Partial<PaymentRow>;
      }) => {
        if (where.id !== state.payment.id) return { count: 0 };
        if (where.status && state.payment.status !== where.status) return { count: 0 };
        Object.assign(state.payment, data);
        return { count: 1 };
      },
    },
    // No referral on this payment — the clawback is a no-op here and has its
    // own coverage in the referrals suite.
    referral: { findUnique: async () => null },
    notification: {
      create: async ({ data }: { data: NotificationRow }) => {
        state.notifications.push(data);
        return { id: `n-${state.notifications.length}` };
      },
    },
    package: {
      update: async ({ where, data }: { where: { id: string }; data: Partial<PackageRow> }) => {
        if (where.id !== state.package.id) throw new Error("wrong package id");
        Object.assign(state.package, data);
        return state.package;
      },
    },
    override: {
      create: async ({
        data,
      }: {
        data: Record<string, unknown> & { actorAdminId: string | null };
      }) => {
        const row = {
          ...(data as unknown as OverrideRow),
          beforeJson: data.beforeJson === Prisma.JsonNull ? null : data.beforeJson,
          afterJson: data.afterJson === Prisma.JsonNull ? null : data.afterJson,
        };
        state.overrides.push(row);
        return { id: `o-${state.overrides.length}` };
      },
    },
  };
  return {
    prisma: {
      payment: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === state.payment.id ? state.payment : null,
      },
      $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
  };
});

const { adminRefundPaymentAction } = await import("@/app/actions/admin-payments");

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  freshState();
  createRefundMock.mockClear();
  captureExceptionMock.mockClear();
  revalidatePathMock.mockClear();
});

describe("adminRefundPaymentAction", () => {
  it("calls Stripe, flips payment+package, writes Override", async () => {
    const res = await adminRefundPaymentAction(
      undefined,
      form({ paymentId: PAYMENT_ID, reason: "duplicate charge" }),
    );

    expect(res).toEqual({ ok: true, refundId: REFUND_ID });
    expect(createRefundMock).toHaveBeenCalledWith({
      paymentIntentId: PAYMENT_INTENT_ID,
      reason: "requested_by_customer",
      // D-143: issued AS the teacher — the charge is on her connected account.
      connectedAccountId: "acct_teacher_1",
    });
    expect(state.payment.status).toBe("refunded");
    expect(state.payment.refundProviderId).toBe(REFUND_ID);
    expect(state.package.status).toBe("refunded");
    expect(state.overrides).toHaveLength(1);
    const o = state.overrides[0]!;
    expect(o).toMatchObject({
      teacherId: TEACHER_ID,
      targetType: "payment",
      targetId: PAYMENT_ID,
      action: "admin_refund",
      reason: "duplicate charge",
      actorAdminId: ADMIN_ID,
    });
    expect(o.afterJson).toMatchObject({ status: "refunded", refundProviderId: REFUND_ID });
  });

  it("tells the student and the teacher, exactly as a teacher-issued refund does", async () => {
    // An admin refund moves the same money out of the same student's hands.
    // Before applyRefund this path notified nobody at all.
    await adminRefundPaymentAction(undefined, form({ paymentId: PAYMENT_ID, reason: "duplicate" }));

    expect(state.notifications).toEqual([
      expect.objectContaining({
        templateName: "refund_issued_student",
        recipientType: "student",
        recipientId: STUDENT_ID,
        paymentId: PAYMENT_ID,
      }),
      expect.objectContaining({
        templateName: "refund_issued_teacher",
        recipientType: "teacher",
        recipientId: TEACHER_ID,
        paymentId: PAYMENT_ID,
      }),
    ]);
  });

  it("refuses to refund a payment that is not paid", async () => {
    state.payment.status = "pending";
    const res = await adminRefundPaymentAction(
      undefined,
      form({ paymentId: PAYMENT_ID, reason: "x" }),
    );
    expect(res).toEqual({ error: "Solo se pueden reembolsar pagos cobrados" });
    expect(createRefundMock).not.toHaveBeenCalled();
    expect(state.overrides).toHaveLength(0);
  });

  it("refuses to refund a Wise payment (settled off-platform)", async () => {
    state.payment.provider = "wise";
    const res = await adminRefundPaymentAction(
      undefined,
      form({ paymentId: PAYMENT_ID, reason: "x" }),
    );
    expect(res?.error).toMatch(/Wise/);
    expect(createRefundMock).not.toHaveBeenCalled();
    expect(state.overrides).toHaveLength(0);
  });

  it("refuses to refund without a Stripe payment_intent", async () => {
    state.payment.providerPaymentId = null;
    const res = await adminRefundPaymentAction(
      undefined,
      form({ paymentId: PAYMENT_ID, reason: "x" }),
    );
    expect(res?.error).toMatch(/payment_intent/);
    expect(createRefundMock).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    const res = await adminRefundPaymentAction(
      undefined,
      form({ paymentId: PAYMENT_ID, reason: "" }),
    );
    expect(res?.error).toBeTruthy();
    expect(createRefundMock).not.toHaveBeenCalled();
  });
});
