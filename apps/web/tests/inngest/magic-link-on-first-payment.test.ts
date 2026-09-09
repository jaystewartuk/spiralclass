import { beforeEach, describe, expect, it, vi } from "vitest";

// After the FIRST paid checkout for a (teacher, student) pair, enqueue a
// notification so the student lands in /my-classes without re-entering their
// email — dispatcher.ts's "magic_link" template builds the actual send
// target from the notification's own id (`r/ml/<id>`), which mints a real
// better-auth session at click time (D-40, lib/auth/server-otp.ts); nothing
// needs to be minted here anymore. Repeat payments and the various
// missing-data cases skip.

vi.mock("@/lib/inngest/client", () => ({ inngest: { createFunction: () => ({}) } }));

const state = {
  payment: { id: "p1" } as { id: string } | null,
  priorPaid: 0,
  existingMagicLink: null as { id: string } | null,
  studentEmail: "mira@x.com" as string | null,
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      findFirst: vi.fn(async () => state.payment),
      count: vi.fn(async () => state.priorPaid),
    },
    notification: { findFirst: vi.fn(async () => state.existingMagicLink) },
    student: {
      findFirst: vi.fn(async () => (state.studentEmail ? { email: state.studentEmail } : null)),
    },
  },
}));

const enqueueMagicLink = vi.fn(async () => "notif1");
vi.mock("@/lib/notifications/enqueue", () => ({ enqueueMagicLink }));
const emitNotificationQueued = vi.fn(async () => {});
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued }));

const { magicLinkOnFirstPaymentHandler } =
  await import("@/lib/inngest/functions/magic-link-on-first-payment");

// Fake step runner: run the callback inline.
const step = { run: async <T>(_id: string, fn: () => T | Promise<T>) => fn() };
function ctx() {
  return { event: { data: { paymentId: "p1", teacherId: "t1", studentId: "s1" } }, step };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.payment = { id: "p1" };
  state.priorPaid = 0;
  state.studentEmail = "mira@x.com";
});

describe("magicLinkOnFirstPaymentHandler", () => {
  it("enqueues the notification on a first payment", async () => {
    const res = await magicLinkOnFirstPaymentHandler(ctx());
    expect(res).toEqual({ sent: true, notificationId: "notif1" });
    expect(enqueueMagicLink).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ teacherId: "t1", studentId: "s1", paymentId: "p1" }),
    );
    expect(emitNotificationQueued).toHaveBeenCalledWith({
      notificationId: "notif1",
      teacherId: "t1",
    });
  });

  it("skips when the payment isn't found", async () => {
    state.payment = null;
    expect(await magicLinkOnFirstPaymentHandler(ctx())).toEqual({ skipped: "payment-not-found" });
  });

  it("skips a repeat payment", async () => {
    state.priorPaid = 1;
    expect(await magicLinkOnFirstPaymentHandler(ctx())).toEqual({ skipped: "not-first-payment" });
    expect(enqueueMagicLink).not.toHaveBeenCalled();
  });

  it("skips a student with no email", async () => {
    state.studentEmail = null;
    expect(await magicLinkOnFirstPaymentHandler(ctx())).toEqual({
      skipped: "student-has-no-email",
    });
  });
});
