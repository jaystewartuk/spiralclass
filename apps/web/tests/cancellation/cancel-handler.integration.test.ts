import { beforeEach, expect, it } from "vitest";
import { handleStudentCancel, handleTeacherCancel } from "@/lib/cancellation/cancel-handler";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";

// Slice 7b — port of tests/cancellation/cancel-handler.unit.test.ts
// against a real Postgres. The handler stays the seam; only the
// surrounding seed + assert layers change.
//
// What this proves vs. the unit suite:
//   * The booking.update + override.create + classes_used increment
//     all land in a single transaction (the unit's `$transaction` shim
//     was a no-op JS callback; here it's a real DB tx — half-applied
//     state would surface).
// * The cross-tenant filter (booking.studentId = input.studentId)
//     enforces against real indexes + FK rows, not just an in-mem
//     filter().
//   * The override row gets persisted with the right `before/after`
//     JSON shapes the audit query relies on.

const TEACHER_A_ID = "11111111-1111-4111-8111-111111111111";
const TEACHER_B_ID = "11111111-1111-4111-8111-bbbbbbbbbbbb";

type SeededCancel = {
  teacherId: string;
  studentId: string;
  packageId: string;
  bookingId: string;
};

async function seedCancellable(opts: {
  teacherId: string;
  teacherEmail: string;
  bookingSlug: string;
  scheduledStart: Date;
  classesUsed?: number;
  scheduleChangesUsed?: number;
}): Promise<SeededCancel> {
  const prisma = getTestPrisma();
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    opts.teacherId,
    opts.teacherEmail,
  );
  const teacher = await prisma.teacher.create({
    data: {
      id: opts.teacherId,
      email: opts.teacherEmail,
      name: `Teacher ${opts.bookingSlug}`,
      timezone: "America/Mexico_City",
      bookingSlug: opts.bookingSlug,
    },
    select: { id: true },
  });
  const student = await prisma.student.create({
    data: {
      email: `student-${opts.bookingSlug}@e2e.test`,
      name: `Student ${opts.bookingSlug}`,
    },
    select: { id: true },
  });
  await prisma.teacherStudent.create({
    data: { teacherId: teacher.id, studentId: student.id },
  });
  const pkg = await prisma.package.create({
    data: {
      teacherId: teacher.id,
      studentId: student.id,
      classesTotal: 10,
      classesUsed: opts.classesUsed ?? 2,
      scheduleChangesUsed: opts.scheduleChangesUsed ?? 0,
      classDurationMin: 50,
      pricePaidMinorUnits: 150_000,
      purchasedAt: new Date(),
      status: "active",
    },
    select: { id: true },
  });
  const booking = await prisma.booking.create({
    data: {
      teacherId: teacher.id,
      studentId: student.id,
      packageId: pkg.id,
      scheduledStart: opts.scheduledStart,
      scheduledEnd: new Date(opts.scheduledStart.getTime() + 50 * 60_000),
      status: "scheduled",
    },
    select: { id: true },
  });
  return {
    teacherId: teacher.id,
    studentId: student.id,
    packageId: pkg.id,
    bookingId: booking.id,
  };
}

describeIntegration("cancel-handler (real DB)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("handleStudentCancel lt24h: status flip + classes_used unchanged (stays committed) + cancel_lt24h notification all land in one tx", async () => {
    const start = new Date(Date.now() + 3 * 3600_000); // 3h from now → lt24h
    const seeded = await seedCancellable({
      teacherId: TEACHER_A_ID,
      teacherEmail: "lt24h@e2e.test",
      bookingSlug: "lt24h",
      scheduledStart: start,
    });
    const prisma = getTestPrisma();
    const events: Array<{ name: string }> = [];

    const outcome = await handleStudentCancel(
      {
        prisma,
        emit: async (e) => {
          events.push({ name: e.name });
        },
      },
      { bookingId: seeded.bookingId, studentIds: [seeded.studentId] },
    );

    expect(outcome.code).toBe("ok");
    if (outcome.code !== "ok") throw new Error();
    expect(outcome.timing).toBe("lt24h");

    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: seeded.bookingId },
    });
    expect(booking.status).toBe("canceled_by_student");

    const pkg = await prisma.package.findUniqueOrThrow({
      where: { id: seeded.packageId },
    });
    expect(pkg.classesUsed).toBe(2); // Model B: lt24h keeps the class committed (penalty)

    const notifs = await prisma.notification.findMany({
      where: { bookingId: seeded.bookingId },
      orderBy: { templateName: "asc" },
    });
    expect(notifs).toHaveLength(2);
    expect(notifs.map((n) => n.templateName)).toEqual(["cancel_lt24h", "cancel_lt24h_teacher"]);
    expect(notifs.every((n) => n.status === "queued")).toBe(true);

    // One notification.queued per row + the booking.canceled event.
    expect(events.map((e) => e.name)).toEqual([
      "notification.queued",
      "notification.queued",
      "booking.canceled",
    ]);
  });

  it("handleStudentCancel ≥24h: refund-cancel — classes_used -= 1 (slot released) + cancel_gte24h notification", async () => {
    const start = new Date(Date.now() + 72 * 3600_000); // 3d
    const seeded = await seedCancellable({
      teacherId: TEACHER_A_ID,
      teacherEmail: "gte24h@e2e.test",
      bookingSlug: "gte24h",
      scheduledStart: start,
    });
    const prisma = getTestPrisma();

    const outcome = await handleStudentCancel(
      { prisma },
      { bookingId: seeded.bookingId, studentIds: [seeded.studentId] },
    );

    expect(outcome.code).toBe("ok");
    if (outcome.code !== "ok") throw new Error();
    expect(outcome.timing).toBe("gte24h");

    const pkg = await prisma.package.findUniqueOrThrow({
      where: { id: seeded.packageId },
    });
    expect(pkg.classesUsed).toBe(1); // Model B: ≥24h releases the committed slot (2 → 1)
    expect(pkg.scheduleChangesUsed).toBe(1); // ≥24h cancel spends one pooled change

    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: seeded.bookingId },
    });
    expect(booking.countsAgainstPackage).toBe(false);

    const notifs = await prisma.notification.findMany({
      where: { bookingId: seeded.bookingId },
      orderBy: { templateName: "asc" },
    });
    expect(notifs.map((n) => n.templateName)).toEqual([
      "cancel_gte24h_teacher",
      "cancel_gte24h_with_reschedule",
    ]);
  });

  it("handleStudentCancel ≥24h with budget spent: refused (schedule-changes-exhausted), nothing mutates", async () => {
    const start = new Date(Date.now() + 72 * 3600_000); // 3d → ≥24h
    const seeded = await seedCancellable({
      teacherId: TEACHER_A_ID,
      teacherEmail: "exhausted@e2e.test",
      bookingSlug: "exhausted",
      scheduledStart: start,
      scheduleChangesUsed: 10, // == classesTotal → budget spent
    });
    const prisma = getTestPrisma();

    const outcome = await handleStudentCancel(
      { prisma },
      { bookingId: seeded.bookingId, studentIds: [seeded.studentId] },
    );

    expect(outcome.code).toBe("schedule-changes-exhausted");

    // The refundable cancel is blocked before the tx — booking, quota, and
    // budget all unchanged; closing the cancel→rebook free-move loophole.
    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: seeded.bookingId },
    });
    expect(booking.status).toBe("scheduled");
    const pkg = await prisma.package.findUniqueOrThrow({
      where: { id: seeded.packageId },
    });
    expect(pkg.classesUsed).toBe(2);
    expect(pkg.scheduleChangesUsed).toBe(10);
    const notifs = await prisma.notification.findMany({
      where: { bookingId: seeded.bookingId },
    });
    expect(notifs).toHaveLength(0);
  });

  it("handleTeacherCancel: writes override row with reason, status flips, classes_used -= 1 (refund)", async () => {
    const start = new Date(Date.now() + 48 * 3600_000);
    const seeded = await seedCancellable({
      teacherId: TEACHER_A_ID,
      teacherEmail: "teacher-cancel@e2e.test",
      bookingSlug: "teacher-cancel",
      scheduledStart: start,
    });
    const prisma = getTestPrisma();

    const outcome = await handleTeacherCancel(
      { prisma },
      {
        bookingId: seeded.bookingId,
        teacherId: seeded.teacherId,
        reason: "Estoy enferma, disculpa.",
      },
    );

    expect(outcome.code).toBe("ok");

    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: seeded.bookingId },
    });
    expect(booking.status).toBe("canceled_by_teacher");

    const pkg = await prisma.package.findUniqueOrThrow({
      where: { id: seeded.packageId },
    });
    expect(pkg.classesUsed).toBe(1); // Model B: teacher cancel refunds the committed slot (2 → 1)

    // Override row got persisted with the audit shape the student-facing
    // history view (teacher overrides) reads from.
    const overrides = await prisma.override.findMany({
      where: { targetType: "booking", targetId: seeded.bookingId },
    });
    expect(overrides).toHaveLength(1);
    expect(overrides[0].action).toBe("teacher_cancel");
    expect(overrides[0].reason).toBe("Estoy enferma, disculpa.");
    expect((overrides[0].afterJson as { status: string }).status).toBe("canceled_by_teacher");
  });

  it("cross-tenant: handleStudentCancel with another student's id finds nothing + no DB mutations", async () => {
    // The unit test already asserts the in-mem filter() returns null;
    // this test proves the real-DB findFirst's `where: {studentId}`
    // clause enforces tenancy under index lookups + FK constraints,
    // not just JS array filtering.
    const seeded = await seedCancellable({
      teacherId: TEACHER_A_ID,
      teacherEmail: "owner@e2e.test",
      bookingSlug: "owner",
      scheduledStart: new Date(Date.now() + 48 * 3600_000),
    });
    // A separate teacher + student combo, just to have a "real" other
    // student id in the DB rather than a string that's never been
    // inserted.
    const intruder = await seedCancellable({
      teacherId: TEACHER_B_ID,
      teacherEmail: "intruder@e2e.test",
      bookingSlug: "intruder",
      scheduledStart: new Date(Date.now() + 48 * 3600_000),
    });
    const prisma = getTestPrisma();

    const outcome = await handleStudentCancel(
      { prisma },
      { bookingId: seeded.bookingId, studentIds: [intruder.studentId] },
    );

    expect(outcome.code).toBe("not-found");

    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: seeded.bookingId },
    });
    expect(booking.status).toBe("scheduled");
    const pkg = await prisma.package.findUniqueOrThrow({
      where: { id: seeded.packageId },
    });
    expect(pkg.classesUsed).toBe(2);
    const notifs = await prisma.notification.findMany({
      where: { bookingId: seeded.bookingId },
    });
    expect(notifs).toHaveLength(0);
  });

  it("rejects already-cancelled booking with wrong-status (no double-deduct)", async () => {
    const seeded = await seedCancellable({
      teacherId: TEACHER_A_ID,
      teacherEmail: "double@e2e.test",
      bookingSlug: "double",
      scheduledStart: new Date(Date.now() + 3 * 3600_000),
    });
    const prisma = getTestPrisma();
    // First cancel succeeds.
    await handleStudentCancel(
      { prisma },
      { bookingId: seeded.bookingId, studentIds: [seeded.studentId] },
    );
    const pkgAfterFirst = await prisma.package.findUniqueOrThrow({
      where: { id: seeded.packageId },
    });
    expect(pkgAfterFirst.classesUsed).toBe(2); // Model B: lt24h keeps it committed (no bump)

    // Second cancel sees the read-time status='canceled_by_student' and
    // returns wrong-status BEFORE entering the transaction. Idempotent
    // by design.
    const second = await handleStudentCancel(
      { prisma },
      { bookingId: seeded.bookingId, studentIds: [seeded.studentId] },
    );
    expect(second.code).toBe("wrong-status");
    const pkgAfterSecond = await prisma.package.findUniqueOrThrow({
      where: { id: seeded.packageId },
    });
    expect(pkgAfterSecond.classesUsed).toBe(2); // wrong-status → no change
  });
});
