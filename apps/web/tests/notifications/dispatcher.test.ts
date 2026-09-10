import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatcherDeps } from "@/lib/notifications/dispatcher";
import { createStubEmailClient } from "@/lib/email/resend";
import { createStubWebPushClient } from "@/lib/notifications/web-push";

// Spied (not the real no-op-in-test implementation) so the reminder→PostHog
// wiring below (the call-analytics review)
// is actually observable — the real trackServerEvent/flushAnalytics both
// return immediately under NODE_ENV=test.
const trackServerEvent = vi.fn();
const flushAnalytics = vi.fn(async () => {});
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent, flushAnalytics }));

// Module-mocked rather than spied: an ESM namespace isn't configurable, so
// vi.spyOn can't patch it. The dispatcher uses exactly one Sentry API.
const captureMessage = vi.fn();
vi.mock("@sentry/nextjs", () => ({ captureMessage }));

const { dispatchNotification } = await import("@/lib/notifications/dispatcher");

// Integration-y test against an in-memory Prisma fake + the real stub Resend
// and push clients. Exercises the dispatcher's core branches: parallel
// push+email delivery, opt-out/no-token fallbacks, retryable vs. non-retryable
// send failures, preference gates, and idempotency on replay.

const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STUDENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BOOKING_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PACKAGE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOTIFICATION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

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

type StudentRow = {
  id: string;
  email: string | null;
  emailOptIn: boolean;
  locale: string;
  name: string;
  teacherId: string;
  // Roster-scoped archive state ("dar de baja") for this teacher's link.
  archivedAt?: Date | null;
  // Roster-scoped silent-onboarding hold for this teacher's link.
  onboardingHoldAt?: Date | null;
};

function buildFakePrisma(state: {
  notifications: Map<string, NotificationRow>;
  students: Map<string, StudentRow>;
  teachers: Map<
    string,
    {
      id: string;
      name: string;
      email: string;
      locale?: string;
      pushOptIn?: boolean;
      emailOptIn?: boolean;
      notificationPrefs?: unknown;
    }
  >;
  bookings: Map<
    string,
    {
      id: string;
      packageId: string;
      scheduledStart: Date;
      scheduledEnd: Date;
      teacherId: string;
      status: string;
    }
  >;
  packages: Map<string, { classesTotal: number; classesUsed: number }>;
  payments?: Map<
    string,
    {
      id: string;
      amountMinorUnits: number;
      paymentReference: string | null;
      teacherId: string;
      packageTemplateName: string | null;
      studentName: string;
    }
  >;
  // Optional browser Web Push subscriptions — indexed by recipientId.
  webPushSubscriptions?: Map<
    string,
    {
      id: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      recipientType: string;
      recipientId: string;
      revokedAt: null;
    }[]
  >;
  // Ids passed to webPushSubscription.updateMany — lets a test assert that a
  // gone (404/410) subscription was soft-revoked.
  revokedWebSubIds?: string[];
}) {
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
      // Models the atomic claim (queued → sending) and its release/terminal
      // writes, honoring the optional `status` guard in the where clause.
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
      findFirst: async ({ where }: { where: { id: string } }) => {
        const t = state.teachers.get(where.id);
        if (!t) return null;
        return { ...t };
      },
    },
    // When LiveKit is configured, the dispatcher asks loadEntitlements() whether
    // to add a "Join call" link to booking emails. Resolve to no subscription
    // row (→ Free → no join link) so these channel tests stay deterministic
    // whether or not LIVEKIT_* is set in the environment.
    teacherSubscription: {
      findUnique: async () => null,
    },
    student: {
      findFirst: async ({ where }: any) => {
        const s = state.students.get(where.id);
        if (!s) return null;
        if (
          where.teacherStudents?.some?.teacherId &&
          s.teacherId !== where.teacherStudents.some.teacherId
        ) {
          return null;
        }
        // Shape the scoped link relation the dispatcher selects to read the
        // archived ("dar de baja") and silent-onboarding-hold states.
        return {
          ...s,
          teacherStudents: [
            {
              archivedAt: s.archivedAt ?? null,
              onboardingHoldAt: s.onboardingHoldAt ?? null,
            },
          ],
        };
      },
      // The dispatcher fans out student token lookups across the identity set
      // (all rows sharing the same email). Return the matching students so the
      // resulting recipientId list is correct for the subscription lookup.
      findMany: async ({ where }: any) => {
        const email = where?.email?.equals ?? null;
        if (!email) return [];
        return Array.from(state.students.values())
          .filter((s) => s.email?.toLowerCase() === email.toLowerCase() && !s.archivedAt)
          .map((s) => ({ id: s.id }));
      },
    },
    booking: {
      findFirst: async ({ where }: any) => {
        const b = state.bookings.get(where.id);
        if (!b) return null;
        if (where.teacherId && b.teacherId !== where.teacherId) return null;
        return b;
      },
    },
    package: {
      findFirst: async ({ where }: any) => {
        const pkg = state.packages.get(where.id);
        if (!pkg) return null;
        return {
          id: where.id,
          studentId: STUDENT_ID,
          classesTotal: pkg.classesTotal,
          classesUsed: pkg.classesUsed,
          expiresAt: null,
          template: null,
          teacher: { bookingSlug: "" },
          student: { name: "" },
        };
      },
    },
    payment: {
      findFirst: async ({ where }: any) => {
        const p = state.payments?.get(where.id);
        if (!p) return null;
        if (where.package?.teacherId && p.teacherId !== where.package.teacherId) return null;
        return {
          id: p.id,
          amountMinorUnits: p.amountMinorUnits,
          paymentReference: p.paymentReference,
          package: {
            id: PACKAGE_ID,
            template: { name: p.packageTemplateName },
            student: { name: p.studentName },
            teacher: { bookingSlug: "" },
          },
        };
      },
    },
    webPushSubscription: {
      findMany: async ({ where }: any) => {
        if (!state.webPushSubscriptions) return [];
        const ids: string[] = Array.isArray(where?.recipientId?.in)
          ? where.recipientId.in
          : where?.recipientId
            ? [where.recipientId]
            : [];
        const rType = where?.recipientType ?? null;
        const results: { id: string; endpoint: string; p256dh: string; auth: string }[] = [];
        for (const [, subs] of state.webPushSubscriptions) {
          for (const s of subs) {
            if (s.revokedAt !== null) continue;
            if (rType && s.recipientType !== rType) continue;
            if (ids.length > 0 && !ids.includes(s.recipientId)) continue;
            results.push({ id: s.id, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth });
          }
        }
        return results;
      },
      updateMany: async ({ where }: any) => {
        const ids: string[] = where?.id?.in ?? [];
        state.revokedWebSubIds = [...(state.revokedWebSubIds ?? []), ...ids];
        return { count: ids.length };
      },
    },
  } as any;
}

function freshRow(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: NOTIFICATION_ID,
    teacherId: TEACHER_ID,
    recipientType: "student",
    recipientId: STUDENT_ID,
    bookingId: BOOKING_ID,
    paymentId: null,
    metadata: null,
    channel: "email",
    templateName: "booking_confirmation",
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

type PaymentRow = {
  id: string;
  amountMinorUnits: number;
  paymentReference: string | null;
  teacherId: string;
  packageTemplateName: string | null;
  studentName: string;
};

function freshState(overrides?: { studentOverrides?: Partial<StudentRow> }) {
  const notifications = new Map<string, NotificationRow>([[NOTIFICATION_ID, freshRow()]]);
  const students = new Map<string, StudentRow>([
    [
      STUDENT_ID,
      {
        id: STUDENT_ID,
        email: "student@example.com",
        emailOptIn: true,
        locale: "es-MX",
        name: "Juan",
        teacherId: TEACHER_ID,
        ...overrides?.studentOverrides,
      },
    ],
  ]);
  const teachers = new Map([
    [
      TEACHER_ID,
      {
        id: TEACHER_ID,
        name: "Alicia Moreno",
        email: "mira@example.com",
        locale: "es-MX",
        // Default opt-ins mirror DB defaults: push+email on.
        pushOptIn: true,
        emailOptIn: true,
        notificationPrefs: null as unknown,
      },
    ],
  ]);
  const bookings = new Map([
    [
      BOOKING_ID,
      {
        id: BOOKING_ID,
        teacherId: TEACHER_ID,
        packageId: PACKAGE_ID,
        scheduledStart: new Date("2026-05-15T15:00:00Z"),
        scheduledEnd: new Date("2026-05-15T15:50:00Z"),
        status: "scheduled",
      },
    ],
  ]);
  const packages = new Map([[PACKAGE_ID, { classesTotal: 20, classesUsed: 2 }]]);
  const payments = new Map<string, PaymentRow>();
  return {
    notifications,
    students,
    teachers,
    bookings,
    packages,
    payments,
    webPushSubscriptions: undefined as
      | Map<
          string,
          {
            id: string;
            endpoint: string;
            p256dh: string;
            auth: string;
            recipientType: string;
            recipientId: string;
            revokedAt: null;
          }[]
        >
      | undefined,
    revokedWebSubIds: undefined as string[] | undefined,
  };
}

// Gives the student a browser Web Push subscription — the `push` channel's
// only transport.
function withWebPushSubscription(
  state: ReturnType<typeof freshState>,
  endpoint = "https://push.example/sub-1",
) {
  state.webPushSubscriptions = new Map([
    [
      STUDENT_ID,
      [
        {
          id: "websub1",
          endpoint,
          p256dh: "p256dh-key",
          auth: "auth-key",
          recipientType: "student",
          recipientId: STUDENT_ID,
          revokedAt: null,
        },
      ],
    ],
  ]);
  return state;
}

describe("dispatchNotification", () => {
  let email: ReturnType<typeof createStubEmailClient>;
  let webPush: ReturnType<typeof createStubWebPushClient>;

  beforeEach(() => {
    email = createStubEmailClient();
    webPush = createStubWebPushClient();
    trackServerEvent.mockClear();
    flushAnalytics.mockClear();
  });

  function deps(prisma: unknown): DispatcherDeps {
    return { prisma: prisma as never, webPush, email, appUrl: "https://app.test" };
  }

  it("push-first cascade: a suppressible template with a live push token pushes and does NOT email", async () => {
    // booking_confirmation is a suppressible lifecycle template → push-first.
    // The recipient has the app, so push delivers and email is suppressed: no
    // more buzzing a push and an identical email for the same event.
    const state = withWebPushSubscription(freshState());
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("sent");
    if (outcome.code !== "sent") throw new Error();
    expect(outcome.channel).toBe("push");
    expect(webPush.sentBatches).toHaveLength(1);
    // Email NOT sent — push landed, so it's redundant.
    expect(email.getSends()).toHaveLength(0);
    // Row updated: primary channel = push; only push recorded in channelsSent.
    const row = state.notifications.get(NOTIFICATION_ID)!;
    expect(row.status).toBe("sent");
    expect(row.languageCode).toBe("es_MX");
    expect((row.metadata as { channelsSent?: string[] } | null)?.channelsSent).toEqual(["push"]);
  });

  it("fan-out: a record-of-truth template (payment_received) sends push AND email", async () => {
    // Money-of-record receipts keep a durable email copy even when push lands.
    const PAYMENT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const state = withWebPushSubscription(freshState());
    const row = state.notifications.get(NOTIFICATION_ID)!;
    row.bookingId = null;
    row.paymentId = PAYMENT_ID;
    row.templateName = "payment_received";
    state.payments.set(PAYMENT_ID, {
      id: PAYMENT_ID,
      amountMinorUnits: 130_000,
      paymentReference: null,
      teacherId: TEACHER_ID,
      packageTemplateName: "Paquete 10",
      studentName: "Juan",
    });
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("sent");
    if (outcome.code !== "sent") throw new Error();
    expect(outcome.channel).toBe("push"); // push is primary (first in order)
    expect(webPush.sentBatches).toHaveLength(1);
    expect(email.getSends()).toHaveLength(1); // durable email copy too
    const channelsSent =
      (state.notifications.get(NOTIFICATION_ID)!.metadata as { channelsSent?: string[] } | null)
        ?.channelsSent ?? [];
    expect(channelsSent).toContain("push");
    expect(channelsSent).toContain("email");
  });

  it("no push token → email only", async () => {
    const state = freshState();
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("sent");
    if (outcome.code !== "sent") throw new Error();
    expect(outcome.channel).toBe("email");
    expect(webPush.sentBatches).toHaveLength(0);
    expect(email.getSends()).toHaveLength(1);
    const row = state.notifications.get(NOTIFICATION_ID)!;
    expect(row.channel).toBe("email");
    expect(row.error).toBeNull();
  });

  it("is idempotent: re-running on a non-queued row is a noop", async () => {
    const state = freshState();
    state.notifications.get(NOTIFICATION_ID)!.status = "delivered";
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("noop");
    expect(email.getSends()).toHaveLength(0);
  });

  it("fails when no channels are eligible (no email, no push token)", async () => {
    const state = freshState({
      studentOverrides: { email: null },
    });
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("failed");
    if (outcome.code !== "failed") throw new Error();
    expect(outcome.reason).toMatch(/undeliverable:no_eligible_channels/);
    // Persisted on the row, which is what makes it diagnosable without an
    // alert — see the Sentry-noise test below.
    const row = state.notifications.get(NOTIFICATION_ID)!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/undeliverable:no_eligible_channels/);
  });

  // SPIRALCLASS-1Z: an `undeliverable:*` outcome is a terminal business fact
  // (the recipient has no channel we're allowed to use), not a fault. Alerting
  // on it produced a permanently-open Sentry issue, which is exactly what a
  // genuine dispatch failure would then hide behind.
  it("does not alert for an undeliverable recipient, but still alerts for real failures", async () => {
    captureMessage.mockClear();

    const noChannels = buildFakePrisma(freshState({ studentOverrides: { email: null } }));
    await dispatchNotification(NOTIFICATION_ID, deps(noChannels));
    expect(captureMessage).not.toHaveBeenCalled();

    // A different terminal reason — a genuine fault — still pages.
    const missingTeacher = freshState();
    missingTeacher.teachers.clear();
    await dispatchNotification(NOTIFICATION_ID, deps(buildFakePrisma(missingTeacher)));
    expect(captureMessage).toHaveBeenCalledWith(
      "dispatcher notification failed",
      expect.objectContaining({ extra: expect.objectContaining({ reason: "teacher-not-found" }) }),
    );
  });

  it("falls back to email on non-retryable push errors instead of dropping the message", async () => {
    const state = withWebPushSubscription(freshState());
    const prisma = buildFakePrisma(state);
    const failingPush = createStubWebPushClient({ "https://push.example/sub-1": "failed" });

    const outcome = await dispatchNotification(NOTIFICATION_ID, {
      prisma,
      webPush: failingPush,
      email,
      appUrl: "https://app.test",
    });

    expect(outcome.code).toBe("sent");
    if (outcome.code !== "sent") throw new Error();
    expect(outcome.channel).toBe("email");
    expect(email.getSends()).toHaveLength(1);
    const row = state.notifications.get(NOTIFICATION_ID)!;
    expect(row.status).toBe("sent");
    expect(row.channel).toBe("email");
    expect(row.error).toBeNull();
    // Hardening: the masked push failure is persisted on the row so a silent
    // push outage is visible/queryable in the DB, not only in the logs.
    expect((row.metadata as { pushError?: string } | null)?.pushError).toBe(
      "all-push-subscriptions-rejected: Http:500",
    );
  });

  it("surfaces the push service's error code on a masked push failure", async () => {
    // Regression for the 2026-07-07 preview credential outage, carried across
    // a transport change: nobody is reached, so the row would look like
    // a healthy "email-only" send. The distinct provider code must reach the
    // persisted pushError so the outage is diagnosable from the DB rather than
    // only from logs.
    const state = withWebPushSubscription(freshState());
    const prisma = buildFakePrisma(state);
    const credFailurePush = createStubWebPushClient({ "https://push.example/sub-1": "gone" });

    const outcome = await dispatchNotification(NOTIFICATION_ID, {
      prisma,
      webPush: credFailurePush,
      email,
      appUrl: "https://app.test",
    });

    expect(outcome.code).toBe("sent");
    if (outcome.code !== "sent") throw new Error();
    expect(outcome.channel).toBe("email");
    const row = state.notifications.get(NOTIFICATION_ID)!;
    expect((row.metadata as { pushError?: string } | null)?.pushError).toBe(
      "all-push-subscriptions-rejected: Gone:410",
    );
  });

  it("non-retryable push error + email opt-out stays failed (no fallback past the opt-out)", async () => {
    const state = withWebPushSubscription(freshState({ studentOverrides: { emailOptIn: false } }));
    const prisma = buildFakePrisma(state);
    const failingPush = createStubWebPushClient({ "https://push.example/sub-1": "failed" });

    const outcome = await dispatchNotification(NOTIFICATION_ID, {
      prisma,
      webPush: failingPush,
      email,
      appUrl: "https://app.test",
    });

    expect(outcome.code).toBe("failed");
    expect(email.getSends()).toHaveLength(0);
    expect(state.notifications.get(NOTIFICATION_ID)!.status).toBe("failed");
  });

  it("cancel_lt24h email includes the cancellation-policy link", async () => {
    const state = freshState();
    state.notifications.set(NOTIFICATION_ID, freshRow({ templateName: "cancel_lt24h" }));
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("sent");
    if (outcome.code !== "sent") throw new Error();
    expect(outcome.channel).toBe("email");
    const sends = email.getSends();
    expect(sends).toHaveLength(1);
    // A Spanish email cites the Spanish document (`?lang=es`); the bare URL is
    // English. The anchor is shared by both variants.
    expect(sends[0].body).toMatch(/terms\?lang=es#cancelaciones/);
  });

  it("notification templates: student.locale='en' routes to 'en' template language", async () => {
    const state = freshState({ studentOverrides: { locale: "en" } });
    const prisma = buildFakePrisma(state);

    await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(state.notifications.get(NOTIFICATION_ID)!.languageCode).toBe("en");
  });

  it("teacher-recipient template (payment_pending_teacher) sends email", async () => {
    const PAYMENT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const state = freshState();
    const row = state.notifications.get(NOTIFICATION_ID)!;
    row.recipientType = "teacher";
    row.recipientId = TEACHER_ID;
    row.bookingId = null;
    row.paymentId = PAYMENT_ID;
    row.templateName = "payment_pending_teacher";
    row.channel = "email";
    state.payments.set(PAYMENT_ID, {
      id: PAYMENT_ID,
      amountMinorUnits: 130_000,
      paymentReference: "AGP-A9842841",
      teacherId: TEACHER_ID,
      packageTemplateName: "8 clases / mes",
      studentName: "Mariana",
    });
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("sent");
    if (outcome.code !== "sent") throw new Error();
    expect(outcome.channel).toBe("email");
    const sends = email.getSends();
    expect(sends).toHaveLength(1);
    expect(sends[0].to).toBe("mira@example.com");
    expect(sends[0].subject).toMatch(/Pago Wise pendiente — Mariana/);
    expect(sends[0].body).toMatch(/AGP-A9842841/);
    // The teacher email is transactional — no unsubscribe footer.
    expect(sends[0].body).not.toMatch(/Para dejar de recibir correos/);
  });

  it("archived pairing suppresses a lifecycle send (link-archived)", async () => {
    // Teacher archived this student ("dar de baja"): the central dispatcher
    // gate drops every lifecycle send for the pairing, no matter the source.
    const state = freshState({
      studentOverrides: { archivedAt: new Date("2026-05-01T00:00:00Z") },
    });
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("noop");
    expect(email.getSends()).toHaveLength(0);
    const row = state.notifications.get(NOTIFICATION_ID)!;
    expect(row.status).toBe("suppressed");
    expect(row.error).toBe("link-archived");
  });

  it("archived pairing still lets a transactional (magic_link) send through", async () => {
    // Sign-in must always work so a reactivated student can get back in.
    const state = freshState({
      studentOverrides: { archivedAt: new Date("2026-05-01T00:00:00Z") },
    });
    const row = state.notifications.get(NOTIFICATION_ID)!;
    row.templateName = "magic_link";
    row.bookingId = null;
    row.metadata = { magicLinkUrl: "https://app.test/ml", expiryMinutes: 60 };
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("sent");
    expect(state.notifications.get(NOTIFICATION_ID)!.error).not.toBe("link-archived");
  });

  it("onboarding hold suppresses a lifecycle send (onboarding-hold)", async () => {
    // Student staged silently before going live: the dispatcher drops every
    // lifecycle send for the pairing until the teacher clears the hold.
    const state = freshState({
      studentOverrides: { onboardingHoldAt: new Date("2026-06-01T00:00:00Z") },
    });
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("noop");
    expect(email.getSends()).toHaveLength(0);
    const row = state.notifications.get(NOTIFICATION_ID)!;
    expect(row.status).toBe("suppressed");
    expect(row.error).toBe("onboarding-hold");
  });

  it("onboarding hold still lets a transactional (magic_link) send through", async () => {
    // Sign-in must always work, even for a not-yet-live student.
    const state = freshState({
      studentOverrides: { onboardingHoldAt: new Date("2026-06-01T00:00:00Z") },
    });
    const row = state.notifications.get(NOTIFICATION_ID)!;
    row.templateName = "magic_link";
    row.bookingId = null;
    row.metadata = { magicLinkUrl: "https://app.test/ml", expiryMinutes: 60 };
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("sent");
    expect(state.notifications.get(NOTIFICATION_ID)!.error).not.toBe("onboarding-hold");
  });

  it("teacher preference gate suppresses a categorized teacher template when off", async () => {
    // Teacher turned off "student_progress" — the lesson-insights review nudge
    // (that category) must be suppressed, same choke point as the student gate.
    const state = freshState();
    state.teachers.set(TEACHER_ID, {
      id: TEACHER_ID,
      name: "Alicia Moreno",
      email: "mira@example.com",
      locale: "es-MX",
      pushOptIn: true,
      emailOptIn: true,
      notificationPrefs: { student_progress: false },
    });
    const row = state.notifications.get(NOTIFICATION_ID)!;
    row.recipientType = "teacher";
    row.recipientId = TEACHER_ID;
    row.templateName = "lesson_insights_review_teacher";
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("noop");
    expect(email.getSends()).toHaveLength(0);
    const updated = state.notifications.get(NOTIFICATION_ID)!;
    expect(updated.status).toBe("suppressed");
    expect(updated.error).toBe("preference-disabled:student_progress");
  });

  it("teacher prefs never mute a non-suppressible (money) teacher notice", async () => {
    // Even with EVERY teacher category turned off, an operational money notice
    // (payment_pending_teacher → teacherTemplateCategory null) still sends.
    const PAYMENT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const state = freshState();
    state.teachers.set(TEACHER_ID, {
      id: TEACHER_ID,
      name: "Alicia Moreno",
      email: "mira@example.com",
      locale: "es-MX",
      pushOptIn: true,
      emailOptIn: true,
      notificationPrefs: { class_activity: false, student_progress: false, subscription: false },
    });
    const row = state.notifications.get(NOTIFICATION_ID)!;
    row.recipientType = "teacher";
    row.recipientId = TEACHER_ID;
    row.bookingId = null;
    row.paymentId = PAYMENT_ID;
    row.templateName = "payment_pending_teacher";
    state.payments.set(PAYMENT_ID, {
      id: PAYMENT_ID,
      amountMinorUnits: 130_000,
      paymentReference: "AGP-A9842841",
      teacherId: TEACHER_ID,
      packageTemplateName: "8 clases / mes",
      studentName: "Mariana",
    });
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("sent");
    if (outcome.code !== "sent") throw new Error();
    expect(outcome.channel).toBe("email");
    expect(email.getSends()).toHaveLength(1);
  });

  it("student push fan-out: token on canonical row delivers push to sibling-row notification", async () => {
    // Multi-teacher tenancy: the same person has two Student rows (one per
    // teacher). The push token is registered under the canonical row (the one
    // with authUserId set). A notification targeting the sibling row should
    // still reach the device by expanding the token lookup to all rows sharing
    // the same email.
    const SIBLING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-cccccccccccc";
    const state = freshState();
    // The notification targets the SIBLING row (different teacher's enrollment).
    const row = state.notifications.get(NOTIFICATION_ID)!;
    row.recipientId = SIBLING_ID;
    // Add a sibling student row (same email as the canonical STUDENT_ID row).
    state.students.set(SIBLING_ID, {
      id: SIBLING_ID,
      email: "student@example.com", // same email as canonical
      emailOptIn: true,
      locale: "es-MX",
      name: "Juan (sibling)",
      teacherId: TEACHER_ID,
    });
    // Push token is registered for the CANONICAL student row, not the sibling.
    withWebPushSubscription(state);
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    // Push should reach the device even though the notification targeted the sibling row.
    expect(outcome.code).toBe("sent");
    if (outcome.code !== "sent") throw new Error();
    expect(outcome.channel).toBe("push");
    expect(webPush.sentBatches).toHaveLength(1);
    expect(webPush.sentBatches[0].subscriptions.map((sub) => sub.endpoint)).toContain(
      "https://push.example/sub-1",
    );
  });

  it('routes a booking-lifecycle template to the "booking" push channel (distinct chime)', async () => {
    const state = withWebPushSubscription(freshState()); // default freshRow() templateName is booking_confirmation
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("sent");
    expect(webPush.sentBatches).toHaveLength(1);
    expect(webPush.sentBatches[0].payload.urgent).toBe(true);
  });

  it('routes a low-urgency template (chat) to the "default" push channel', async () => {
    const state = freshState();
    state.notifications.set(
      NOTIFICATION_ID,
      freshRow({ templateName: "chat_message", bookingId: null, metadata: { preview: "Hola" } }),
    );
    withWebPushSubscription(state);
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("sent");
    expect(webPush.sentBatches).toHaveLength(1);
    expect(webPush.sentBatches[0].payload.urgent).toBe(false);
  });

  it("teacher_cancel with push token → push only, no email (push-first cascade)", async () => {
    // teacher_cancel is a suppressible booking-update → push-first. The student
    // has the app, so push delivers and the redundant email is suppressed.
    const state = freshState();
    state.notifications.set(NOTIFICATION_ID, freshRow({ templateName: "teacher_cancel" }));
    withWebPushSubscription(state, "https://push.example/sub-xyz");
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("sent");
    if (outcome.code !== "sent") throw new Error();
    expect(outcome.channel).toBe("push"); // push is primary (first in order)
    expect(webPush.sentBatches).toHaveLength(1);
    expect(email.getSends()).toHaveLength(0); // email suppressed — push landed
    const row = state.notifications.get(NOTIFICATION_ID)!;
    const channelsSent = (row.metadata as { channelsSent?: string[] } | null)?.channelsSent ?? [];
    expect(channelsSent).toEqual(["push"]);
  });

  it("push-first fallback: a suppressible template with a rejected push token emails immediately", async () => {
    // teacher_cancel again, but the subscription is dead: push fails
    // non-retryably, so the cascade falls through to email in the same attempt.
    const state = freshState();
    state.notifications.set(NOTIFICATION_ID, freshRow({ templateName: "teacher_cancel" }));
    withWebPushSubscription(state, "https://push.example/sub-dead");
    const prisma = buildFakePrisma(state);
    const failingPush = createStubWebPushClient({ "https://push.example/sub-dead": "gone" });

    const outcome = await dispatchNotification(NOTIFICATION_ID, {
      prisma,
      webPush: failingPush,
      email,
      appUrl: "https://app.test",
    });

    expect(outcome.code).toBe("sent");
    if (outcome.code !== "sent") throw new Error();
    expect(outcome.channel).toBe("email");
    expect(email.getSends()).toHaveLength(1);
    const row = state.notifications.get(NOTIFICATION_ID)!;
    expect((row.metadata as { channelsSent?: string[] } | null)?.channelsSent).toEqual(["email"]);
  });

  it("teacher_cancel push deep-link routes to rebooking, not the canceled booking", async () => {
    // The canceled booking no longer makes sense as a destination; push should
    // deep-link to the rebooking redirect so the student can pick a new slot
    // using their restored credit. The suffix arrives rooted at "/" — it is a
    // browser notification, and an unrooted path is not a URL.
    const state = freshState();
    state.notifications.set(NOTIFICATION_ID, freshRow({ templateName: "teacher_cancel" }));
    withWebPushSubscription(state);
    const prisma = buildFakePrisma(state);

    await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(webPush.sentBatches).toHaveLength(1);
    expect(webPush.sentBatches[0].payload.deepLink).toBe(`/r/re/${BOOKING_ID}`);
  });

  it("cancel_lt24h push deep-link routes to rebooking", async () => {
    const state = freshState();
    state.notifications.set(NOTIFICATION_ID, freshRow({ templateName: "cancel_lt24h" }));
    withWebPushSubscription(state);
    const prisma = buildFakePrisma(state);

    await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(webPush.sentBatches).toHaveLength(1);
    expect(webPush.sentBatches[0].payload.deepLink).toBe(`/r/re/${BOOKING_ID}`);
  });

  it("retry idempotency (fan-out): channels in metadata.channelsSent are not re-sent", async () => {
    // Simulate a prior retry that already sent push on a FAN-OUT template
    // (payment_received). On re-entry, push should be skipped and the remaining
    // channel (email) still attempted, because a receipt fans out to both.
    const PAYMENT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const state = freshState();
    const row = state.notifications.get(NOTIFICATION_ID)!;
    row.bookingId = null;
    row.paymentId = PAYMENT_ID;
    row.templateName = "payment_received";
    row.metadata = { channelsSent: ["push"] } as any;
    state.payments.set(PAYMENT_ID, {
      id: PAYMENT_ID,
      amountMinorUnits: 130_000,
      paymentReference: null,
      teacherId: TEACHER_ID,
      packageTemplateName: "Paquete 10",
      studentName: "Juan",
    });
    withWebPushSubscription(state);
    const prisma = buildFakePrisma(state);

    await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    // Push was in channelsSent → must NOT be re-sent.
    expect(webPush.sentBatches).toHaveLength(0);
    // Email is fresh → sent (fan-out keeps the durable copy).
    expect(email.getSends()).toHaveLength(1);
  });

  it("retry idempotency (cascade): a prior push stops the cascade — no duplicate email", async () => {
    // booking_confirmation is push-first. If push already delivered on a prior
    // attempt, re-entry must NOT fall through and email a message the recipient
    // was already pushed.
    const state = freshState();
    state.notifications.get(NOTIFICATION_ID)!.metadata = { channelsSent: ["push"] } as any;
    withWebPushSubscription(state);
    const prisma = buildFakePrisma(state);

    await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(webPush.sentBatches).toHaveLength(0); // not re-sent
    expect(email.getSends()).toHaveLength(0); // cascade stops at the prior push
  });

  it("tracks call_reminder_sent for a class-reminder template, with the right lead time", async () => {
    const state = withWebPushSubscription(freshState());
    state.notifications.get(NOTIFICATION_ID)!.templateName = "reminder_1h";
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(outcome.code).toBe("sent");
    expect(trackServerEvent).toHaveBeenCalledWith({
      name: "call_reminder_sent",
      distinctId: STUDENT_ID,
      properties: {
        teacherId: TEACHER_ID,
        studentId: STUDENT_ID,
        bookingId: BOOKING_ID,
        channel: "push",
        leadTimeMinutes: 60,
        recipientType: "student",
      },
    });
    expect(flushAnalytics).toHaveBeenCalled();
  });

  it("does not fire call_reminder_sent for a non-reminder template", async () => {
    const state = withWebPushSubscription(freshState());
    const prisma = buildFakePrisma(state);

    await dispatchNotification(NOTIFICATION_ID, deps(prisma));

    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  // --- Web Push: the browser transport of the same `push` channel ---------
  //
  // The case this whole transport exists for: a recipient with no device,
  // reachable only in a browser. Before web push she was tokenless, so the
  // push-first cascade fell straight through to email.

  it("web-push-only recipient is push-reachable: pushes to the browser and does NOT email", async () => {
    const state = withWebPushSubscription(freshState());
    const prisma = buildFakePrisma(state);
    const webPush = createStubWebPushClient();

    const outcome = await dispatchNotification(NOTIFICATION_ID, {
      ...deps(prisma),
      webPush,
    });

    expect(outcome.code).toBe("sent");
    expect(webPush.sentBatches).toHaveLength(1);
    expect(webPush.sentBatches[0].subscriptions.map((s) => s.endpoint)).toEqual([
      "https://push.example/sub-1",
    ]);
    // The cascade stopped at push — no duplicate email for the same event.
    expect(email.getSends()).toHaveLength(0);

    const row = state.notifications.get(NOTIFICATION_ID)!;
    expect(row.channel).toBe("push");
    expect(row.status).toBe("sent");
    // Web Push reports delivery synchronously and mints no receipt, so
    // the row is delivered NOW rather than left for poll-push-receipts — which
    // would rescan it hourly looking for tickets that will never exist.
    expect(row.deliveredAt).not.toBeNull();
    expect(row.providerMessageId).toBe(`webpush:${NOTIFICATION_ID}`);
  });

  it("soft-revokes a browser subscription the push service reports as gone", async () => {
    const state = withWebPushSubscription(freshState());
    const prisma = buildFakePrisma(state);
    // 410 Gone — permission revoked or site data cleared.
    const webPush = createStubWebPushClient({ "https://push.example/sub-1": "gone" });

    await dispatchNotification(NOTIFICATION_ID, { ...deps(prisma), webPush });

    expect(state.revokedWebSubIds).toEqual(["websub1"]);
    // Nothing was reached on push, so the cascade fell through to email
    // rather than silently dropping the message.
    expect(email.getSends()).toHaveLength(1);
  });

  it("falls through to email when the browser subscription send fails transiently", async () => {
    const state = withWebPushSubscription(freshState());
    const prisma = buildFakePrisma(state);
    const webPush = createStubWebPushClient({ "https://push.example/sub-1": "failed" });

    const outcome = await dispatchNotification(NOTIFICATION_ID, { ...deps(prisma), webPush });

    expect(outcome.code).toBe("sent");
    expect(email.getSends()).toHaveLength(1);
    // A transient failure must NOT revoke the subscription — only a 404/410
    // means it's permanently gone.
    expect(state.revokedWebSubIds ?? []).toEqual([]);
    // The failure is persisted on the row, not just logged, so a silent
    // web-push outage is queryable rather than reading as healthy email-only.
    const row = state.notifications.get(NOTIFICATION_ID)!;
    expect(String(row.metadata?.pushError)).toContain("Http:500");
  });

  it("without a webPush client configured, a browser-only recipient gets email", async () => {
    // A deploy with no VAPID keypair passes webPush: null. A recipient with
    // only a browser subscription is then NOT push-reachable and must get the
    // email — never silently nothing.
    const state = withWebPushSubscription(freshState());
    const prisma = buildFakePrisma(state);

    const outcome = await dispatchNotification(NOTIFICATION_ID, {
      ...deps(prisma),
      webPush: null,
    });

    expect(outcome.code).toBe("sent");
    expect(email.getSends()).toHaveLength(1);
    const row = state.notifications.get(NOTIFICATION_ID)!;
    expect(row.channel).toBe("email");
    // The push branch must not even be attempted: stored subscriptions we have
    // no keypair to send to don't make the recipient push-reachable, so no
    // misleading pushError is stamped on a row whose real channel was email.
    expect(row.metadata?.pushError).toBeUndefined();
  });
});
