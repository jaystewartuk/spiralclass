import { beforeEach, describe, expect, it } from "vitest";
import {
  dispatchNotification,
  sendChatEmailFallbackIfUnread,
  type DispatcherDeps,
} from "@/lib/notifications/dispatcher";
import { createStubEmailClient } from "@/lib/email/resend";
import { createStubWebPushClient } from "@/lib/notifications/web-push";

// Chat notifications deliver push-first and only email later if the recipient
// never opened the thread — verifying both halves here:
//   * the dispatcher's cascade `break` (push wins → email is NOT also sent), and
//   * sendChatEmailFallbackIfUnread (email iff a sender message is still unread).

const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STUDENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOTIFICATION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

type MessageRow = {
  id?: string;
  teacherId: string;
  studentId: string;
  senderRole: "teacher" | "student";
  readAt: Date | null;
  deletedAt?: Date | null;
};

type NotificationRow = {
  id: string;
  teacherId: string;
  recipientType: "student" | "teacher";
  recipientId: string;
  bookingId: string | null;
  paymentId: string | null;
  metadata: Record<string, unknown> | null;
  channel: "push" | "email";
  templateName: string;
  languageCode: string | null;
  status: "queued" | "sending" | "sent" | "delivered" | "failed" | "suppressed";
  error: string | null;
  providerMessageId: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  failedAt: Date | null;
};

function buildFakePrisma(state: {
  notifications: Map<string, NotificationRow>;
  messages: MessageRow[];
  webPushSubscriptions?: {
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    recipientType: string;
    recipientId: string;
  }[];
}) {
  const teacher = {
    id: TEACHER_ID,
    name: "Alicia Moreno",
    email: "mira@example.com",
    timezone: "America/Mexico_City",
    locale: "es-MX",
    notificationPrefs: null as unknown,
    pushOptIn: true,
    emailOptIn: true,
  };
  const student = {
    id: STUDENT_ID,
    email: "student@example.com",
    emailOptIn: true,
    pushOptIn: true,
    notificationPrefs: null as unknown,
    locale: "es-MX",
    name: "Juan",
    teacherId: TEACHER_ID,
    archivedAt: null as Date | null,
    onboardingHoldAt: null as Date | null,
  };
  return {
    notification: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.notifications.get(where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<NotificationRow>;
      }) => {
        const row = state.notifications.get(where.id)!;
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status?: string };
        data: Partial<NotificationRow>;
      }) => {
        const row = state.notifications.get(where.id);
        if (!row) return { count: 0 };
        if (where.status && row.status !== where.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    teacher: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === TEACHER_ID ? { ...teacher } : null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === TEACHER_ID ? { ...teacher } : null,
    },
    student: {
      findFirst: async ({ where }: any) => {
        if (where.id !== STUDENT_ID) return null;
        if (
          where.teacherStudents?.some?.teacherId &&
          where.teacherStudents.some.teacherId !== TEACHER_ID
        ) {
          return null;
        }
        return {
          ...student,
          teacherStudents: [
            { archivedAt: student.archivedAt, onboardingHoldAt: student.onboardingHoldAt },
          ],
        };
      },
      findMany: async ({ where }: any) => {
        const email = where?.email?.equals ?? null;
        if (!email || student.email?.toLowerCase() !== email.toLowerCase()) return [];
        return [{ id: student.id }];
      },
    },
    webPushSubscription: {
      findMany: async ({ where }: any) => {
        const subs = state.webPushSubscriptions ?? [];
        const ids: string[] = Array.isArray(where?.recipientId?.in)
          ? where.recipientId.in
          : where?.recipientId
            ? [where.recipientId]
            : [];
        return subs
          .filter((t) => (where?.recipientType ? t.recipientType === where.recipientType : true))
          .filter((t) => (ids.length > 0 ? ids.includes(t.recipientId) : true))
          .map((t) => ({ id: t.id, endpoint: t.endpoint, p256dh: t.p256dh, auth: t.auth }));
      },
      updateMany: async () => ({ count: 0 }),
    },
    message: {
      findFirst: async ({ where }: any) => state.messages.find((m) => m.id === where.id) ?? null,
      count: async ({ where }: any) =>
        state.messages.filter(
          (m) =>
            m.teacherId === where.teacherId &&
            m.studentId === where.studentId &&
            m.senderRole === where.senderRole &&
            (where.readAt === null ? m.readAt === null : true) &&
            (where.deletedAt === null ? (m.deletedAt ?? null) === null : true),
        ).length,
    },
  } as any;
}

function chatRow(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: NOTIFICATION_ID,
    teacherId: TEACHER_ID,
    recipientType: "student",
    recipientId: STUDENT_ID,
    bookingId: null,
    paymentId: null,
    metadata: { preview: "hola" },
    channel: "email",
    templateName: "chat_message",
    languageCode: null,
    status: "queued",
    error: null,
    providerMessageId: null,
    sentAt: null,
    deliveredAt: null,
    failedAt: null,
    ...overrides,
  };
}

const PUSH_SUBSCRIPTION = {
  id: "websub1",
  endpoint: "https://push.example/sub-1",
  p256dh: "p256dh-key",
  auth: "auth-key",
  recipientType: "student",
  recipientId: STUDENT_ID,
};

describe("chat notification cascade", () => {
  let email: ReturnType<typeof createStubEmailClient>;
  let webPush: ReturnType<typeof createStubWebPushClient>;

  beforeEach(() => {
    email = createStubEmailClient();
    webPush = createStubWebPushClient();
  });

  function deps(prisma: unknown): DispatcherDeps {
    return { prisma: prisma as never, webPush, email, appUrl: "https://app.test" };
  }

  it("push-first: with a push subscription it pushes and does NOT also email", async () => {
    const state = {
      notifications: new Map([[NOTIFICATION_ID, chatRow()]]),
      messages: [] as MessageRow[],
      webPushSubscriptions: [PUSH_SUBSCRIPTION],
    };
    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(buildFakePrisma(state)));

    expect(outcome.code).toBe("sent");
    if (outcome.code !== "sent") throw new Error();
    expect(outcome.channel).toBe("push");
    expect(outcome.templateName).toBe("chat_message");
    expect(webPush.sentBatches).toHaveLength(1);
    expect(email.getSends()).toHaveLength(0); // cascade: email deferred, not sent now
    const row = state.notifications.get(NOTIFICATION_ID)!;
    expect((row.metadata as { channelsSent?: string[] }).channelsSent).toEqual(["push"]);
    // The raw suffix carries a role prefix (`s/`) that is not a web route —
    // rooting it at "/" would 404. It must arrive translated.
    expect(webPush.sentBatches[0].payload.deepLink).toBe(`/my-classes/messages/${TEACHER_ID}`);
  });

  it("no push subscription → emails immediately (nothing to defer)", async () => {
    const state = {
      notifications: new Map([[NOTIFICATION_ID, chatRow()]]),
      messages: [] as MessageRow[],
    };
    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(buildFakePrisma(state)));

    expect(outcome.code).toBe("sent");
    if (outcome.code !== "sent") throw new Error();
    expect(outcome.channel).toBe("email");
    expect(webPush.sentBatches).toHaveLength(0);
    expect(email.getSends()).toHaveLength(1);
  });
});

describe("sendChatEmailFallbackIfUnread", () => {
  let email: ReturnType<typeof createStubEmailClient>;
  let webPush: ReturnType<typeof createStubWebPushClient>;

  beforeEach(() => {
    email = createStubEmailClient();
    webPush = createStubWebPushClient();
  });

  function deps(prisma: unknown): DispatcherDeps {
    return { prisma: prisma as never, webPush, email, appUrl: "https://app.test" };
  }

  // A chat_message already delivered via push, so an email fallback is pending.
  function pushedRow(overrides: Partial<NotificationRow> = {}): NotificationRow {
    return chatRow({
      status: "sent",
      channel: "push",
      metadata: { preview: "hola", channelsSent: ["push"] },
      ...overrides,
    });
  }

  it("emails when a sender message is still unread", async () => {
    const state = {
      notifications: new Map([[NOTIFICATION_ID, pushedRow()]]),
      messages: [
        {
          teacherId: TEACHER_ID,
          studentId: STUDENT_ID,
          senderRole: "teacher" as const,
          readAt: null,
        },
      ],
    };
    const outcome = await sendChatEmailFallbackIfUnread(
      NOTIFICATION_ID,
      deps(buildFakePrisma(state)),
    );

    expect(outcome.code).toBe("sent");
    expect(email.getSends()).toHaveLength(1);
    const row = state.notifications.get(NOTIFICATION_ID)!;
    expect((row.metadata as { channelsSent?: string[] }).channelsSent).toEqual(
      expect.arrayContaining(["push", "email"]),
    );
  });

  it("does NOT email once the recipient has opened the thread (message read)", async () => {
    const state = {
      notifications: new Map([[NOTIFICATION_ID, pushedRow()]]),
      messages: [
        {
          teacherId: TEACHER_ID,
          studentId: STUDENT_ID,
          senderRole: "teacher" as const,
          readAt: new Date(),
        },
      ],
    };
    const outcome = await sendChatEmailFallbackIfUnread(
      NOTIFICATION_ID,
      deps(buildFakePrisma(state)),
    );

    expect(outcome).toEqual({ code: "skipped", reason: "read" });
    expect(email.getSends()).toHaveLength(0);
  });

  it("does not double-send when email already went out", async () => {
    const state = {
      notifications: new Map([
        [
          NOTIFICATION_ID,
          pushedRow({ metadata: { preview: "hola", channelsSent: ["push", "email"] } }),
        ],
      ]),
      messages: [
        {
          teacherId: TEACHER_ID,
          studentId: STUDENT_ID,
          senderRole: "teacher" as const,
          readAt: null,
        },
      ],
    };
    const outcome = await sendChatEmailFallbackIfUnread(
      NOTIFICATION_ID,
      deps(buildFakePrisma(state)),
    );

    expect(outcome).toEqual({ code: "skipped", reason: "already-emailed" });
    expect(email.getSends()).toHaveLength(0);
  });

  it("skips via metadata.messageId when THAT message was deleted, even with other unread traffic", async () => {
    // Scenario: A (sensitive) pushed, B sent right after, A deleted within the
    // 3-minute grace window. B being unread must not resurrect A's preview.
    const state = {
      notifications: new Map([
        [
          NOTIFICATION_ID,
          pushedRow({ metadata: { preview: "secret", messageId: "mA", channelsSent: ["push"] } }),
        ],
      ]),
      messages: [
        {
          id: "mA",
          teacherId: TEACHER_ID,
          studentId: STUDENT_ID,
          senderRole: "teacher" as const,
          readAt: null,
          deletedAt: new Date(),
        },
        {
          id: "mB",
          teacherId: TEACHER_ID,
          studentId: STUDENT_ID,
          senderRole: "teacher" as const,
          readAt: null,
        },
      ],
    };
    const outcome = await sendChatEmailFallbackIfUnread(
      NOTIFICATION_ID,
      deps(buildFakePrisma(state)),
    );

    expect(outcome).toEqual({ code: "skipped", reason: "message-deleted" });
    expect(email.getSends()).toHaveLength(0);
  });

  it("does NOT email when the only unread message was deleted-for-everyone", async () => {
    // The stored preview must never resurface content the sender retracted.
    const state = {
      notifications: new Map([[NOTIFICATION_ID, pushedRow()]]),
      messages: [
        {
          teacherId: TEACHER_ID,
          studentId: STUDENT_ID,
          senderRole: "teacher" as const,
          readAt: null,
          deletedAt: new Date(),
        },
      ],
    };
    const outcome = await sendChatEmailFallbackIfUnread(
      NOTIFICATION_ID,
      deps(buildFakePrisma(state)),
    );

    expect(outcome).toEqual({ code: "skipped", reason: "read" });
    expect(email.getSends()).toHaveLength(0);
  });

  it("skips when push never delivered (nothing to fall back from)", async () => {
    const state = {
      notifications: new Map([
        [NOTIFICATION_ID, pushedRow({ metadata: { preview: "hola", channelsSent: [] } })],
      ]),
      messages: [
        {
          teacherId: TEACHER_ID,
          studentId: STUDENT_ID,
          senderRole: "teacher" as const,
          readAt: null,
        },
      ],
    };
    const outcome = await sendChatEmailFallbackIfUnread(
      NOTIFICATION_ID,
      deps(buildFakePrisma(state)),
    );

    expect(outcome).toEqual({ code: "skipped", reason: "no-push-prior" });
    expect(email.getSends()).toHaveLength(0);
  });
});
