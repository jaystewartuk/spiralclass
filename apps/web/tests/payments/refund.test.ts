import { beforeEach, describe, expect, it, vi } from "vitest";

// Teacher-initiated Stripe refund (`refundPaymentAction`). MVP
// supports full refunds only; the action calls Stripe Refunds API,
// then atomically:
//   - flips Payment.status → refunded (+ refundedAt + refundProviderId)
//   - flips Package.status → refunded
//   - logs an Override row with `action='refund'`
//   - queues refund_issued_student + refund_issued_teacher (via applyRefund)
//
// That last one is the fix for a silent production bug: the action flipped the
// status itself, so Stripe's `charge.refunded` webhook — the only thing that
// enqueued those two rows — hit `advancePayment`'s `already-refunded` no-op
// and sent nothing. A student's package went to "Reembolsado" with no email,
// no push and no inbox row.
//
// Errors `redirect()` to /payments/<id>?error=<code>; success redirects
// to /payments/<id>?refunded=1. We mock `redirect` to throw a captured
// error so the test inspects the URL deterministically.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TEACHER_ID = "11111111-1111-4111-8111-bbbbbbbbbbbb";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const PACKAGE_ID = "44444444-4444-4444-8444-444444444444";
const PAYMENT_ID = "77777777-7777-4777-8777-777777777777";
const PROVIDER_PAYMENT_ID = "pi_TEST_1";
const STRIPE_ACCOUNT_ID = "acct_TEST_1";

type PaymentRow = {
  id: string;
  packageId: string;
  status: string;
  provider: string;
  providerPaymentId: string | null;
  refundedAt: Date | null;
  refundProviderId: string | null;
  amountMinorUnits: number;
};
type PackageRow = {
  id: string;
  teacherId: string;
  studentId: string;
  status: string;
};
type OverrideRow = {
  id: string;
  teacherId: string;
  targetType: string;
  targetId: string;
  action: string;
  reason: string;
  beforeJson: unknown;
  afterJson: unknown;
};

const state: {
  payments: Map<string, PaymentRow>;
  packages: Map<string, PackageRow>;
  overrides: OverrideRow[];
  notifications: Array<{ templateName: string; recipientType: string; recipientId: string }>;
  emitted: string[];
  refundCalls: Array<{ paymentIntentId: string; reason?: string }>;
  refundShouldThrow: boolean;
} = {
  payments: new Map(),
  packages: new Map(),
  overrides: [],
  notifications: [],
  emitted: [],
  refundCalls: [],
  refundShouldThrow: false,
};

let teacherStripeAccount: string | null = STRIPE_ACCOUNT_ID;

class TestRedirect extends Error {
  constructor(public path: string) {
    super(`redirect:${path}`);
  }
}

function freshState() {
  state.payments.clear();
  state.packages.clear();
  state.overrides.length = 0;
  state.notifications.length = 0;
  state.emitted.length = 0;
  state.refundCalls.length = 0;
  state.refundShouldThrow = false;
  teacherStripeAccount = STRIPE_ACCOUNT_ID;

  state.payments.set(PAYMENT_ID, {
    id: PAYMENT_ID,
    packageId: PACKAGE_ID,
    status: "paid",
    provider: "stripe",
    providerPaymentId: PROVIDER_PAYMENT_ID,
    refundedAt: null,
    refundProviderId: null,
    amountMinorUnits: 150_000,
  });
  state.packages.set(PACKAGE_ID, {
    id: PACKAGE_ID,
    teacherId: TEACHER_ID,
    studentId: STUDENT_ID,
    status: "active",
  });
}

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({
    id: TEACHER_ID,
    timezone: "America/Mexico_City",
    stripeAccountId: teacherStripeAccount,
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// `@/lib/notifications/events` reaches the jobs backend (and through it
// serverEnv) at import time. The enqueue producers themselves run for real
// against the tx stub below, so the assertions are about real rows.
vi.mock("@/lib/notifications/events", () => ({
  emitNotificationQueued: vi.fn(async (input: { notificationId: string }) => {
    state.emitted.push(input.notificationId);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new TestRedirect(path);
  }),
}));

vi.mock("@/lib/stripe", () => ({
  getStripeClient: () => ({
    createRefund: async (input: {
      paymentIntentId: string;
      reason?: string;
      connectedAccountId?: string;
    }) => {
      state.refundCalls.push(input);
      if (state.refundShouldThrow) throw new Error("Stripe rejected");
      return {
        id: `re_TEST_${input.paymentIntentId}`,
        status: "succeeded",
        amount: 150_000,
        payment_intent: input.paymentIntentId,
      };
    },
  }),
}));

vi.mock("@/lib/prisma", () => {
  function snapshot<T>(row: T | null): T | null {
    return row ? ({ ...(row as object) } as T) : null;
  }
  function paymentFindFirst({ where, include }: any) {
    void include;
    for (const p of state.payments.values()) {
      if (where.id && p.id !== where.id) continue;
      if (where.package?.teacherId) {
        const pkg = state.packages.get(p.packageId);
        if (!pkg || pkg.teacherId !== where.package.teacherId) continue;
      }
      const snap = snapshot(p)!;
      const pkg = state.packages.get(p.packageId);
      // The action selects teacherId + studentId so applyRefund can address
      // both notifications; a stub that dropped them made the rows look
      // correct while addressing nobody.
      return {
        ...snap,
        package: { id: p.packageId, teacherId: pkg?.teacherId, studentId: pkg?.studentId },
      };
    }
    return null;
  }
  function paymentUpdate({ where, data }: any) {
    const p = state.payments.get(where.id);
    if (!p) throw new Error(`no payment ${where.id}`);
    Object.assign(p, data);
    return p;
  }
  // Race-safe refund flip: `updateMany` with a `status: "paid"` guard so a
  // concurrent second refund becomes a no-op (count: 0).
  function paymentUpdateMany({ where, data }: any) {
    const p = state.payments.get(where.id);
    if (!p) return { count: 0 };
    if (where.status && p.status !== where.status) return { count: 0 };
    Object.assign(p, data);
    return { count: 1 };
  }
  function packageUpdate({ where, data }: any) {
    const pkg = state.packages.get(where.id);
    if (!pkg) throw new Error(`no package ${where.id}`);
    Object.assign(pkg, data);
    return pkg;
  }
  function overrideCreate({ data }: any) {
    const row: OverrideRow = {
      id: `override-${state.overrides.length + 1}`,
      ...data,
    };
    state.overrides.push(row);
    return row;
  }
  function notificationCreate({ data }: any) {
    state.notifications.push(data);
    return { id: `notif-${state.notifications.length}` };
  }
  const tx = {
    payment: { update: paymentUpdate, updateMany: paymentUpdateMany },
    package: { update: packageUpdate },
    override: { create: overrideCreate },
    notification: { create: notificationCreate },
    // Slice 2b clawback no-op: no referral on this payment.
    referral: { findUnique: async () => null },
  };
  return {
    prisma: {
      payment: { findFirst: paymentFindFirst },
      $transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    },
  };
});

const { refundPaymentAction } = await import("@/app/actions/refund");

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

async function runAndCaptureRedirect(fd: FormData): Promise<string> {
  try {
    await refundPaymentAction(fd);
  } catch (err) {
    if (err instanceof TestRedirect) return err.path;
    throw err;
  }
  throw new Error("expected redirect to be thrown");
}

beforeEach(() => {
  freshState();
  vi.clearAllMocks();
});

describe("refundPaymentAction — happy path", () => {
  it("calls Stripe refund, flips both rows + logs override row, redirects to ?refunded=1", async () => {
    const path = await runAndCaptureRedirect(
      form({
        paymentId: PAYMENT_ID,
        reason: "Alumno no podrá tomar las clases — refund completo",
      }),
    );
    expect(path).toBe(`/payments/${PAYMENT_ID}?refunded=1`);

    expect(state.refundCalls).toHaveLength(1);
    expect(state.refundCalls[0]).toEqual({
      paymentIntentId: PROVIDER_PAYMENT_ID,
      reason: "requested_by_customer",
      // D-143: the refund is created AS the teacher, because the charge lives
      // on her connected account. Without this Stripe cannot find the PI.
      connectedAccountId: STRIPE_ACCOUNT_ID,
    });

    const payment = state.payments.get(PAYMENT_ID)!;
    expect(payment.status).toBe("refunded");
    expect(payment.refundedAt).toBeInstanceOf(Date);
    expect(payment.refundProviderId).toBe(`re_TEST_${PROVIDER_PAYMENT_ID}`);
    expect(state.packages.get(PACKAGE_ID)?.status).toBe("refunded");

    expect(state.overrides).toHaveLength(1);
    expect(state.overrides[0]).toMatchObject({
      teacherId: TEACHER_ID,
      targetType: "payment",
      targetId: PAYMENT_ID,
      action: "refund",
      reason: "Alumno no podrá tomar las clases — refund completo",
      beforeJson: { status: "paid" },
      afterJson: expect.objectContaining({
        status: "refunded",
        refundProviderId: `re_TEST_${PROVIDER_PAYMENT_ID}`,
      }),
    });
  });

  it("tells the student AND the teacher the money went back", async () => {
    await runAndCaptureRedirect(form({ paymentId: PAYMENT_ID, reason: "Refund completo" }));

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
    // Dispatched after the commit, never for a rolled-back insert.
    expect(state.emitted).toEqual(["notif-1", "notif-2"]);
  });

  it("notifies once, not once per refund attempt", async () => {
    await runAndCaptureRedirect(form({ paymentId: PAYMENT_ID, reason: "Primero" }));
    expect(state.notifications).toHaveLength(2);

    // A second submit on an already-refunded payment stops at ?error=not-paid,
    // and behind that the `status: "paid"` guard inside applyRefund would match
    // no rows anyway. Either way the student hears about the refund once.
    const path = await runAndCaptureRedirect(form({ paymentId: PAYMENT_ID, reason: "Segundo" }));
    expect(path).toBe(`/payments/${PAYMENT_ID}?error=not-paid`);
    expect(state.notifications).toHaveLength(2);
    expect(state.overrides).toHaveLength(1);
  });
});

describe("refundPaymentAction — error paths", () => {
  it("redirects to ?error=missing-reason when reason is empty", async () => {
    const path = await runAndCaptureRedirect(form({ paymentId: PAYMENT_ID, reason: "" }));
    expect(path).toBe("/payments?error=missing-reason");
    expect(state.refundCalls).toHaveLength(0);
    expect(state.payments.get(PAYMENT_ID)?.status).toBe("paid");
  });

  it("redirects to ?error=no-account when teacher hasn't connected Stripe", async () => {
    teacherStripeAccount = null;
    const path = await runAndCaptureRedirect(
      form({ paymentId: PAYMENT_ID, reason: "Reembolso solicitado por mi alumno" }),
    );
    expect(path).toBe(`/payments/${PAYMENT_ID}?error=no-account`);
    expect(state.refundCalls).toHaveLength(0);
  });

  it("tenant isolation: redirects to ?error=missing-payment when payment belongs to another teacher", async () => {
    state.packages.get(PACKAGE_ID)!.teacherId = OTHER_TEACHER_ID;
    const path = await runAndCaptureRedirect(
      form({ paymentId: PAYMENT_ID, reason: "Tenant bypass attempt" }),
    );
    expect(path).toBe("/payments?error=missing-payment");
    expect(state.refundCalls).toHaveLength(0);
    expect(state.overrides).toHaveLength(0);
  });

  it("redirects to ?error=not-paid when the payment isn't in 'paid' state", async () => {
    state.payments.get(PAYMENT_ID)!.status = "pending";
    const path = await runAndCaptureRedirect(
      form({ paymentId: PAYMENT_ID, reason: "Pendiente, no debería refunds" }),
    );
    expect(path).toBe(`/payments/${PAYMENT_ID}?error=not-paid`);
    expect(state.refundCalls).toHaveLength(0);
    expect(state.payments.get(PAYMENT_ID)?.status).toBe("pending");
  });

  it("redirects to ?error=not-stripe for a Wise payment (settled off-platform)", async () => {
    state.payments.get(PAYMENT_ID)!.provider = "wise";
    const path = await runAndCaptureRedirect(
      form({ paymentId: PAYMENT_ID, reason: "Wise no se reembolsa por Stripe" }),
    );
    expect(path).toBe(`/payments/${PAYMENT_ID}?error=not-stripe`);
    expect(state.refundCalls).toHaveLength(0);
  });

  it("redirects to ?error=no-payment-intent when payment has no provider id", async () => {
    state.payments.get(PAYMENT_ID)!.providerPaymentId = null;
    const path = await runAndCaptureRedirect(
      form({ paymentId: PAYMENT_ID, reason: "Sin id de Stripe" }),
    );
    expect(path).toBe(`/payments/${PAYMENT_ID}?error=no-payment-intent`);
    expect(state.refundCalls).toHaveLength(0);
  });

  it("redirects to ?error=stripe-error when Stripe refund call throws + does NOT mutate any rows", async () => {
    state.refundShouldThrow = true;
    const path = await runAndCaptureRedirect(
      form({ paymentId: PAYMENT_ID, reason: "Stripe devuelve 500" }),
    );
    expect(path).toBe(`/payments/${PAYMENT_ID}?error=stripe-error`);
    expect(state.refundCalls).toHaveLength(1);
    // Atomicity: the Stripe failure must not leave a half-written DB. The
    // production path bails out *before* the $transaction block.
    expect(state.payments.get(PAYMENT_ID)?.status).toBe("paid");
    expect(state.packages.get(PACKAGE_ID)?.status).toBe("active");
    expect(state.overrides).toHaveLength(0);
  });
});
