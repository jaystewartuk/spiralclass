import { describe, expect, it, vi } from "vitest";
import {
  enqueueMagicLink,
  enqueuePaymentPendingTeacher,
  enqueuePaymentReceived,
  enqueueReminder,
  enqueueReminderTeacher,
  enqueueRescheduleConfirm,
} from "@/lib/notifications/enqueue";

// Typed notification producers. Two things must never drift: (1) the
// per-template row shape the dispatcher reads back (templateName, recipient
// type, metadata), and (2) the tenant isolation invariants every row carries — a
// teacher_id, status='queued', and a concrete channel (the dispatcher
// overrides the channel at send time; producers just seed a starting value —
// 'push' or 'email').

function fakeTx() {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    notification: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "notif-1" };
      }),
    },
  };
  return { tx: tx as never, created };
}

describe("enqueue producers — universal invariants", () => {
  it("every produced row carries teacherId, queued status, and a concrete channel", async () => {
    const { tx, created } = fakeTx();
    await enqueuePaymentReceived(tx, {
      teacherId: "t1",
      studentId: "s1",
      paymentId: "p1",
      packageId: "pkg1",
    });
    await enqueuePaymentPendingTeacher(tx, { teacherId: "t1", paymentId: "p1" });
    for (const row of created) {
      expect(row.teacherId).toBe("t1");
      expect(row.status).toBe("queued");
      expect(["push", "email"]).toContain(row.channel);
      expect(["student", "teacher"]).toContain(row.recipientType);
      expect(typeof row.templateName).toBe("string");
      expect(row.templateName).not.toBe("");
    }
  });
});

describe("enqueuePaymentReceived", () => {
  it("writes a student row with the package id in metadata", async () => {
    const { tx, created } = fakeTx();
    const id = await enqueuePaymentReceived(tx, {
      teacherId: "t1",
      studentId: "s1",
      paymentId: "p1",
      packageId: "pkg1",
    });
    expect(id).toBe("notif-1");
    expect(created[0]).toMatchObject({
      recipientType: "student",
      recipientId: "s1",
      paymentId: "p1",
      templateName: "payment_received",
      metadata: { packageId: "pkg1" },
    });
  });
});

describe("enqueueReminder", () => {
  it.each([
    ["24h", "reminder_24h"],
    ["1h", "reminder_1h"],
  ] as const)("maps which=%s to template %s", async (which, template) => {
    const { tx, created } = fakeTx();
    await enqueueReminder(tx, {
      teacherId: "t1",
      studentId: "s1",
      bookingId: "b1",
      which,
    });
    expect(created[0].templateName).toBe(template);
    expect(created[0].bookingId).toBe("b1");
  });
});

describe("enqueueReminderTeacher", () => {
  it.each([
    ["24h", "reminder_24h_teacher"],
    ["1h", "reminder_1h_teacher"],
    ["15m", "reminder_15m_teacher"],
  ] as const)("maps which=%s to teacher template %s", async (which, template) => {
    const { tx, created } = fakeTx();
    await enqueueReminderTeacher(tx, { teacherId: "t1", bookingId: "b1", which });
    expect(created[0]).toMatchObject({
      recipientType: "teacher",
      recipientId: "t1",
      bookingId: "b1",
      templateName: template,
    });
  });
});

describe("enqueueRescheduleConfirm", () => {
  it("serialises oldScheduledStart to an ISO string in metadata", async () => {
    const { tx, created } = fakeTx();
    await enqueueRescheduleConfirm(tx, {
      teacherId: "t1",
      studentId: "s1",
      bookingId: "b1",
      oldScheduledStart: new Date("2026-06-01T15:00:00Z"),
    });
    expect(created[0].metadata).toEqual({
      oldScheduledStart: "2026-06-01T15:00:00.000Z",
    });
  });
});

describe("enqueueMagicLink", () => {
  it("carries the link + expiry in metadata and defaults paymentId to null", async () => {
    const { tx, created } = fakeTx();
    await enqueueMagicLink(tx, {
      teacherId: "t1",
      studentId: "s1",
      magicLinkUrl: "https://x/y",
      expiryMinutes: 60,
    });
    expect(created[0]).toMatchObject({
      templateName: "magic_link",
      paymentId: null,
      metadata: { magicLinkUrl: "https://x/y", expiryMinutes: 60 },
    });
  });
});

describe("enqueuePaymentPendingTeacher", () => {
  it("writes a teacher-recipient row", async () => {
    const { tx, created } = fakeTx();
    await enqueuePaymentPendingTeacher(tx, { teacherId: "t1", paymentId: "p1" });
    expect(created[0]).toMatchObject({
      recipientType: "teacher",
      templateName: "payment_pending_teacher",
      paymentId: "p1",
    });
  });
});
