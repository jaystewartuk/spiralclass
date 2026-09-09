import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendTransferConfirmReminders } from "@/lib/payments/transfer-confirm-reminder";

// wise-confirm-reminder.ts default-imports emitNotificationQueued, which
// pulls in the real inngest client (env-validated at import time). Stub it
// so this file needs no server env — mirrors tests/actions/booking-action.test.ts.
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued: vi.fn() }));

const NOW = new Date("2026-06-15T12:00:00Z");
const TWENTY_FIVE_HOURS_AGO = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
const ONE_HOUR_AGO = new Date(NOW.getTime() - 1 * 60 * 60 * 1000);
const FORTY_EIGHT_HOURS_AGO = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);

type PaymentRow = {
  id: string;
  provider: "stripe" | "manual_transfer";
  status: "pending" | "paid" | "failed" | "refunded";
  studentMarkedSentAt: Date | null;
  confirmedAt: Date | null;
  teacherId: string;
};

type NotificationRow = {
  id: string;
  teacherId: string;
  recipientType: string;
  recipientId: string;
  paymentId: string | null;
  channel: string;
  templateName: string;
  status: string;
};

type FakeState = { payments: PaymentRow[]; notifications: NotificationRow[] };

// Mirrors the fake-Prisma-per-test style used in tests/payments/cleanup-pending.test.ts —
// the query shapes below match the where/select clauses in wise-confirm-reminder.ts exactly.
function fakePrisma(state: FakeState) {
  return {
    payment: {
      findMany: vi.fn(async ({ where }: any) => {
        const cutoff: Date = where.studentMarkedSentAt.lte;
        const matched = state.payments.filter(
          (p) =>
            p.provider === "manual_transfer" &&
            p.status === "pending" &&
            p.studentMarkedSentAt !== null &&
            p.studentMarkedSentAt <= cutoff &&
            p.confirmedAt === null,
        );
        return matched.map((p) => ({ id: p.id, package: { teacherId: p.teacherId } }));
      }),
    },
    notification: {
      findMany: vi.fn(async ({ where }: any) => {
        const ids: string[] = where.paymentId.in;
        const matched = state.notifications.filter(
          (n) => n.templateName === where.templateName && ids.includes(n.paymentId ?? ""),
        );
        return matched.map((n) => ({ paymentId: n.paymentId }));
      }),
      create: vi.fn(async ({ data }: any) => {
        const row: NotificationRow = { id: `notif-${state.notifications.length + 1}`, ...data };
        state.notifications.push(row);
        return { id: row.id };
      }),
    },
  } as any;
}

describe("sendTransferConfirmReminders", () => {
  let state: FakeState;

  beforeEach(() => {
    state = { payments: [], notifications: [] };
  });

  it("does nothing when there are no stuck Wise payments", async () => {
    const emit = vi.fn();
    const result = await sendTransferConfirmReminders({
      prisma: fakePrisma(state),
      emit,
      now: NOW,
    });

    expect(result).toEqual({ ok: true, sent: 0, skipped: 0 });
    expect(emit).not.toHaveBeenCalled();
    expect(state.notifications).toHaveLength(0);
  });

  it("reminds the teacher for a Wise payment marked sent past the stale threshold", async () => {
    state.payments = [
      {
        id: "pay-1",
        provider: "manual_transfer",
        status: "pending",
        studentMarkedSentAt: TWENTY_FIVE_HOURS_AGO,
        confirmedAt: null,
        teacherId: "teacher-1",
      },
    ];
    const emit = vi.fn();

    const result = await sendTransferConfirmReminders({
      prisma: fakePrisma(state),
      emit,
      now: NOW,
    });

    expect(result).toEqual({ ok: true, sent: 1, skipped: 0 });
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toMatchObject({
      teacherId: "teacher-1",
      recipientType: "teacher",
      recipientId: "teacher-1",
      paymentId: "pay-1",
      channel: "email",
      templateName: "wise_confirm_reminder_teacher",
      status: "queued",
    });
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith({
      notificationId: state.notifications[0].id,
      teacherId: "teacher-1",
    });
  });

  it("leaves payments marked sent more recently than the stale threshold alone", async () => {
    state.payments = [
      {
        id: "pay-fresh",
        provider: "manual_transfer",
        status: "pending",
        studentMarkedSentAt: ONE_HOUR_AGO,
        confirmedAt: null,
        teacherId: "teacher-1",
      },
    ];
    const emit = vi.fn();

    const result = await sendTransferConfirmReminders({
      prisma: fakePrisma(state),
      emit,
      now: NOW,
    });

    expect(result).toEqual({ ok: true, sent: 0, skipped: 0 });
    expect(emit).not.toHaveBeenCalled();
  });

  it("ignores Stripe payments, already-confirmed payments, and non-pending payments", async () => {
    state.payments = [
      {
        id: "pay-stripe",
        provider: "stripe",
        status: "pending",
        studentMarkedSentAt: TWENTY_FIVE_HOURS_AGO,
        confirmedAt: null,
        teacherId: "teacher-1",
      },
      {
        id: "pay-confirmed",
        provider: "manual_transfer",
        status: "pending",
        studentMarkedSentAt: TWENTY_FIVE_HOURS_AGO,
        confirmedAt: TWENTY_FIVE_HOURS_AGO,
        teacherId: "teacher-1",
      },
      {
        id: "pay-paid",
        provider: "manual_transfer",
        status: "paid",
        studentMarkedSentAt: TWENTY_FIVE_HOURS_AGO,
        confirmedAt: null,
        teacherId: "teacher-1",
      },
    ];

    const result = await sendTransferConfirmReminders({ prisma: fakePrisma(state), now: NOW });

    expect(result).toEqual({ ok: true, sent: 0, skipped: 0 });
    expect(state.notifications).toHaveLength(0);
  });

  it("sends exactly one reminder per payment, ever — re-running skips already-reminded payments", async () => {
    state.payments = [
      {
        id: "pay-1",
        provider: "manual_transfer",
        status: "pending",
        studentMarkedSentAt: FORTY_EIGHT_HOURS_AGO,
        confirmedAt: null,
        teacherId: "teacher-1",
      },
    ];

    const first = await sendTransferConfirmReminders({ prisma: fakePrisma(state), now: NOW });
    expect(first).toEqual({ ok: true, sent: 1, skipped: 0 });
    expect(state.notifications).toHaveLength(1);

    const second = await sendTransferConfirmReminders({ prisma: fakePrisma(state), now: NOW });
    expect(second).toEqual({ ok: true, sent: 0, skipped: 1 });
    // No duplicate notification row was inserted.
    expect(state.notifications).toHaveLength(1);
  });

  it("handles a mix in one run: reminds new stuck payments, skips already-reminded ones", async () => {
    state.payments = [
      {
        id: "pay-old",
        provider: "manual_transfer",
        status: "pending",
        studentMarkedSentAt: FORTY_EIGHT_HOURS_AGO,
        confirmedAt: null,
        teacherId: "teacher-1",
      },
      {
        id: "pay-new",
        provider: "manual_transfer",
        status: "pending",
        studentMarkedSentAt: TWENTY_FIVE_HOURS_AGO,
        confirmedAt: null,
        teacherId: "teacher-2",
      },
    ];
    state.notifications = [
      {
        id: "notif-existing",
        teacherId: "teacher-1",
        recipientType: "teacher",
        recipientId: "teacher-1",
        paymentId: "pay-old",
        channel: "email",
        templateName: "wise_confirm_reminder_teacher",
        status: "queued",
      },
    ];

    const result = await sendTransferConfirmReminders({ prisma: fakePrisma(state), now: NOW });

    expect(result).toEqual({ ok: true, sent: 1, skipped: 1 });
    expect(state.notifications).toHaveLength(2);
    expect(state.notifications.find((n) => n.paymentId === "pay-new")).toBeDefined();
  });

  it("respects a custom staleHours threshold", async () => {
    state.payments = [
      {
        id: "pay-1",
        provider: "manual_transfer",
        status: "pending",
        studentMarkedSentAt: ONE_HOUR_AGO,
        confirmedAt: null,
        teacherId: "teacher-1",
      },
    ];

    // With a 0.5h threshold, a payment marked sent 1h ago is already stale.
    const result = await sendTransferConfirmReminders({
      prisma: fakePrisma(state),
      now: NOW,
      staleHours: 0.5,
    });

    expect(result).toEqual({ ok: true, sent: 1, skipped: 0 });
  });

  it("defaults `emit` to a no-op-safe call when not provided", async () => {
    state.payments = [
      {
        id: "pay-1",
        provider: "manual_transfer",
        status: "pending",
        studentMarkedSentAt: TWENTY_FIVE_HOURS_AGO,
        confirmedAt: null,
        teacherId: "teacher-1",
      },
    ];

    // Real emitNotificationQueued swallows its own errors (inngest.send may
    // fail in a test/CI env without inngest configured); this should not throw.
    await expect(
      sendTransferConfirmReminders({ prisma: fakePrisma(state), now: NOW }),
    ).resolves.toEqual({ ok: true, sent: 1, skipped: 0 });
  });
});
