import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationStatus, Prisma } from "@prisma/client";

// Issue #85: an invitation that bounced still read as sent, because the send
// left no `notifications` row for the Resend webhook to match. These tests
// drive the real send path and the real webhook handler against one in-memory
// notifications table, so they prove the two meet on the provider message id.

const sendMock = vi.fn();
vi.mock("@/lib/email", () => ({
  getEmailClient: () => ({ send: sendMock }),
}));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  serverEnv: () => ({ APP_URL: "https://spiralclass.test" }),
}));

const { sendInvitationEmail } = await import("./send");
const { handleResendWebhook } = await import("@/lib/notifications/email-webhook");
const { INVITATION_NOTIFICATION_TEMPLATE } = await import("./constants");

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const INVITATION_ID = "33333333-3333-4333-8333-333333333333";

type Row = {
  teacherId: string;
  recipientType: string;
  recipientId: string;
  channel: string;
  templateName: string;
  status: NotificationStatus;
  providerMessageId: string | null;
  metadata: unknown;
  languageCode: string | null;
  sentAt: Date | null;
  deliveredAt?: Date | null;
  failedAt?: Date | null;
  error?: string | null;
};

function fakeNotifications() {
  const rows: Row[] = [];
  const notification = {
    create: vi.fn(async ({ data }: { data: Prisma.NotificationUncheckedCreateInput }) => {
      rows.push({ ...(data as Row) });
      return data;
    }),
    updateMany: async ({
      where,
      data,
    }: {
      where: { providerMessageId: string; status: { in: NotificationStatus[] } };
      data: Prisma.NotificationUpdateManyMutationInput;
    }) => {
      let count = 0;
      for (const r of rows) {
        if (r.providerMessageId === where.providerMessageId && where.status.in.includes(r.status)) {
          Object.assign(r, data as Partial<Row>);
          count += 1;
        }
      }
      return { count };
    },
    findFirst: async ({ where }: { where: { providerMessageId: string } }) => {
      const r = rows.find((x) => x.providerMessageId === where.providerMessageId);
      return r ? { status: r.status } : null;
    },
  };
  return { rows, db: { notification } };
}

const sendInput = {
  to: "student@example.com",
  teacherName: "Mira",
  studentName: "Sam",
  rawToken: "tok",
  locale: "es",
  teacherAvatarUrl: null,
  messagingEnabled: false,
  record: { teacherId: TEACHER_ID, studentId: STUDENT_ID, invitationId: INVITATION_ID },
};

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({ ok: true, providerMessageId: "re_msg_1" });
});

describe("sendInvitationEmail records the send", () => {
  it("leaves a notifications row carrying the provider message id", async () => {
    const { rows, db } = fakeNotifications();
    const res = await sendInvitationEmail(sendInput, db);

    expect(res.providerMessageId).toBe("re_msg_1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      teacherId: TEACHER_ID,
      recipientType: "student",
      recipientId: STUDENT_ID,
      channel: "email",
      templateName: INVITATION_NOTIFICATION_TEMPLATE,
      status: "sent",
      providerMessageId: "re_msg_1",
      languageCode: "es",
      metadata: { invitationId: INVITATION_ID },
    });
    expect(rows[0]?.sentAt).toBeInstanceOf(Date);
  });

  it("a bounce webhook marks the invitation's row failed", async () => {
    const { rows, db } = fakeNotifications();
    await sendInvitationEmail(sendInput, db);

    const outcome = await handleResendWebhook(
      { type: "email.bounced", data: { email_id: "re_msg_1" } },
      { prisma: db },
    );

    expect(outcome).toEqual({ code: "applied", providerMessageId: "re_msg_1", status: "failed" });
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.error).toBe("resend:email.bounced");
  });

  it("a delivered webhook marks the invitation's row delivered", async () => {
    const { rows, db } = fakeNotifications();
    await sendInvitationEmail(sendInput, db);

    const outcome = await handleResendWebhook(
      { type: "email.delivered", data: { email_id: "re_msg_1" } },
      { prisma: db },
    );

    expect(outcome).toMatchObject({ code: "applied", status: "delivered" });
    expect(rows[0]?.status).toBe("delivered");
  });

  it("writes no row when the provider rejects the send, and still throws", async () => {
    sendMock.mockResolvedValue({ ok: false, error: "nope", code: "x", retryable: false });
    const { rows, db } = fakeNotifications();
    await expect(sendInvitationEmail(sendInput, db)).rejects.toThrow(
      "invitation-email-send-failed",
    );
    expect(rows).toHaveLength(0);
  });

  it("does not fail an email that already went out when the record write fails", async () => {
    // The student has the email; throwing here would make the caller discard
    // or refuse an invitation that was in fact sent.
    const { db } = fakeNotifications();
    db.notification.create.mockRejectedValueOnce(new Error("db down"));
    await expect(sendInvitationEmail(sendInput, db)).resolves.toEqual({
      providerMessageId: "re_msg_1",
    });
  });
});
