import { beforeAll, beforeEach, expect, it } from "vitest";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { createStubEmailClient } from "@/lib/email/resend";
import { createStubWebPushClient } from "@/lib/notifications/web-push";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";

// Integration port of tests/notifications/dispatcher.test.ts. The unit
// version exercises every branch against an in-memory Prisma fake; this
// run hits a real Postgres so the tenant isolation join filters
// (`teacherStudents.some.teacherId`, package belongs to teacher, etc.)
// trip on actual SQL rather than on the fake's hand-rolled clauses.
//
// Asserts:
//   - real-DB dispatch: row flips status='sent' and we persist
//     providerMessageId + sentAt across the connection
//   - cross-tenant student: dispatcher refuses to send when the
//     notification's teacherId doesn't match the student's joined
//     teacher_id (fails closed)
//   - idempotency: replaying a notification that's already sent returns
//     `noop:not-queued` and does not double-send

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const TEACHER_OTHER_ID = "11111111-1111-4111-8111-bbbbbbbbbbbb";

async function ensureAuthUser(id: string, email: string) {
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    id,
    email,
  );
}

async function seed(opts: {
  studentJoinedToOtherTeacher?: boolean;
  notificationOverrides?: Record<string, unknown>;
}): Promise<{
  teacherId: string;
  studentId: string;
  bookingId: string;
  notificationId: string;
}> {
  const prisma = getTestPrisma();
  await ensureAuthUser(TEACHER_ID, "teacher-disp@e2e.test");
  await ensureAuthUser(TEACHER_OTHER_ID, "teacher-other@e2e.test");
  await prisma.teacher.create({
    data: {
      id: TEACHER_ID,
      email: "teacher-disp@e2e.test",
      name: "Alicia Moreno",
      timezone: "America/Mexico_City",
      bookingSlug: "teacher-disp",
      phoneE164: "+5215500000099",
    },
  });
  await prisma.teacher.create({
    data: {
      id: TEACHER_OTHER_ID,
      email: "teacher-other@e2e.test",
      name: "Other Teacher",
      timezone: "America/Mexico_City",
      bookingSlug: "other-teacher",
    },
  });

  const student = await prisma.student.create({
    data: {
      email: "alumno@e2e.test",
      name: "Alumno",
      phoneE164: "+5215500000001",
      locale: "es-MX",
    },
    select: { id: true },
  });
  // Cross-tenant scenario: student is joined to teacher OTHER, not to TEACHER_ID.
  await prisma.teacherStudent.create({
    data: {
      teacherId: opts.studentJoinedToOtherTeacher ? TEACHER_OTHER_ID : TEACHER_ID,
      studentId: student.id,
    },
  });

  const pkg = await prisma.package.create({
    data: {
      teacherId: opts.studentJoinedToOtherTeacher ? TEACHER_OTHER_ID : TEACHER_ID,
      studentId: student.id,
      classesTotal: 20,
      classesUsed: 2,
      classDurationMin: 50,
      pricePaidMinorUnits: 550_000,
      purchasedAt: new Date(),
      status: "active",
    },
    select: { id: true, teacherId: true },
  });

  const booking = await prisma.booking.create({
    data: {
      teacherId: pkg.teacherId,
      studentId: student.id,
      packageId: pkg.id,
      scheduledStart: new Date("2026-05-15T15:00:00.000Z"),
      scheduledEnd: new Date("2026-05-15T15:50:00.000Z"),
      status: "scheduled",
    },
    select: { id: true },
  });

  const notification = await prisma.notification.create({
    data: {
      teacherId: TEACHER_ID, // always TEACHER_ID — that's the dispatch claim
      recipientType: "student",
      recipientId: student.id,
      bookingId: booking.id,
      channel: "email",
      templateName: "booking_confirmation",
      status: "queued",
      ...opts.notificationOverrides,
    },
    select: { id: true },
  });

  return {
    teacherId: TEACHER_ID,
    studentId: student.id,
    bookingId: booking.id,
    notificationId: notification.id,
  };
}

describeIntegration("dispatchNotification (real DB)", () => {
  beforeAll(async () => {
    await truncateAll();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  it("happy path: email send, row flips to 'sent' with providerMessageId", async () => {
    const { notificationId } = await seed({});
    const email = createStubEmailClient();
    const webPush = createStubWebPushClient();

    const outcome = await dispatchNotification(notificationId, {
      prisma: getTestPrisma(),
      webPush,
      email,
      appUrl: "https://app.test",
    });
    expect(outcome.code).toBe("sent");
    if (outcome.code !== "sent") throw new Error();
    // No device token registered → email is the only eligible channel.
    expect(outcome.channel).toBe("email");

    expect(email.getSends()).toHaveLength(1);

    const row = await getTestPrisma().notification.findUniqueOrThrow({
      where: { id: notificationId },
    });
    expect(row.status).toBe("sent");
    expect(row.channel).toBe("email");
    expect(row.languageCode).toBe("es_MX");
    expect(row.providerMessageId).toBe(outcome.providerMessageId);
    expect(row.sentAt).toBeInstanceOf(Date);
  });

  it("idempotency: a second dispatch of the same notificationId is a noop, no second send", async () => {
    const { notificationId } = await seed({});
    const email = createStubEmailClient();
    const webPush = createStubWebPushClient();

    const first = await dispatchNotification(notificationId, {
      prisma: getTestPrisma(),
      webPush,
      email,
      appUrl: "https://app.test",
    });
    expect(first.code).toBe("sent");

    const second = await dispatchNotification(notificationId, {
      prisma: getTestPrisma(),
      webPush,
      email,
      appUrl: "https://app.test",
    });
    expect(second.code).toBe("noop");
    if (second.code !== "noop") throw new Error();
    expect(second.reason).toBe("not-queued");
    // Critical invariant: no double-send across replay.
    expect(email.getSends()).toHaveLength(1);
  });

  it(": cross-tenant — notification claims teacher A but recipient student belongs to teacher B → marked failed", async () => {
    const { notificationId } = await seed({ studentJoinedToOtherTeacher: true });
    const email = createStubEmailClient();
    const webPush = createStubWebPushClient();

    const outcome = await dispatchNotification(notificationId, {
      prisma: getTestPrisma(),
      webPush,
      email,
      appUrl: "https://app.test",
    });
    expect(outcome.code).toBe("failed");
    if (outcome.code !== "failed") throw new Error();
    expect(outcome.reason).toMatch(/student-not-found-or-not-on-teacher/);
    // No outbound send happened.
    expect(email.getSends()).toHaveLength(0);

    const row = await getTestPrisma().notification.findUniqueOrThrow({
      where: { id: notificationId },
    });
    expect(row.status).toBe("failed");
    expect(row.failedAt).toBeInstanceOf(Date);
  });
});
