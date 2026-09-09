import { Prisma } from "@prisma/client";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";

// — concurrent booking race. CLAUDE.md flagged this
// explicitly: the partial unique index on
// `(teacher_id, scheduled_start) WHERE status='scheduled'` is the only
// line of defense against two students racing into the same slot. The
// materializer's idempotent re-run case in materialize-monthly already
// exercises the index indirectly; this test is the explicit student-
// side race that the concurrent-booking race calls for.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";

async function ensureAuthUser(id: string, email: string) {
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    id,
    email,
  );
}

async function seedTeacher() {
  const prisma = getTestPrisma();
  await ensureAuthUser(TEACHER_ID, "teacher-concurrent@e2e.test");
  return prisma.teacher.create({
    data: {
      id: TEACHER_ID,
      email: "teacher-concurrent@e2e.test",
      name: "Test Teacher",
      timezone: "America/Mexico_City",
      bookingSlug: "concurrent-teacher",
    },
    select: { id: true },
  });
}

async function seedStudentWithPackage(opts: {
  studentEmail: string;
}): Promise<{ studentId: string; packageId: string }> {
  const prisma = getTestPrisma();
  const student = await prisma.student.create({
    data: {
      email: opts.studentEmail,
      name: opts.studentEmail.split("@")[0],
    },
    select: { id: true },
  });
  await prisma.teacherStudent.create({
    data: { teacherId: TEACHER_ID, studentId: student.id },
  });
  const pkg = await prisma.package.create({
    data: {
      teacherId: TEACHER_ID,
      studentId: student.id,
      classesTotal: 10,
      classDurationMin: 50,
      pricePaidMinorUnits: 150_000,
      purchasedAt: new Date(),
      status: "active",
    },
    select: { id: true },
  });
  return { studentId: student.id, packageId: pkg.id };
}

describeIntegration("booking concurrency (real DB)", () => {
  beforeAll(async () => {
    await truncateAll();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  it("server-authoritative unique partial index: 20 concurrent inserts at the same scheduled_start, exactly one wins", async () => {
    await seedTeacher();
    const seeded = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        seedStudentWithPackage({ studentEmail: `s${i}@race.test` }),
      ),
    );
    const prisma = getTestPrisma();
    const slot = new Date("2026-06-15T16:00:00.000Z");
    const slotEnd = new Date(slot.getTime() + 50 * 60_000);

    // Promise.all races all 20 inserts. The DB's partial unique index
    // serializes them — exactly one winner, 19 P2002 losers.
    const results = await Promise.allSettled(
      seeded.map((s) =>
        prisma.booking.create({
          data: {
            teacherId: TEACHER_ID,
            studentId: s.studentId,
            packageId: s.packageId,
            scheduledStart: slot,
            scheduledEnd: slotEnd,
            status: "scheduled",
          },
        }),
      ),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(19);
    for (const r of failed) {
      const err = (r as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
    }
    const persisted = await prisma.booking.findMany({
      where: { teacherId: TEACHER_ID, status: "scheduled" },
      select: { id: true, scheduledStart: true },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].scheduledStart.toISOString()).toBe(slot.toISOString());
  });

  it("partial-index scope: a canceled_by_student row at the same slot does NOT block a new scheduled booking", async () => {
    await seedTeacher();
    const a = await seedStudentWithPackage({
      studentEmail: "canceled-first@race.test",
    });
    const b = await seedStudentWithPackage({
      studentEmail: "second-attempt@race.test",
    });
    const prisma = getTestPrisma();
    const slot = new Date("2026-07-01T16:00:00.000Z");
    const slotEnd = new Date(slot.getTime() + 50 * 60_000);

    // A canceled. The partial unique index excludes non-scheduled rows
    // (`WHERE status='scheduled'`), so this must not block (b)'s insert.
    await prisma.booking.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: a.studentId,
        packageId: a.packageId,
        scheduledStart: slot,
        scheduledEnd: slotEnd,
        status: "canceled_by_student",
      },
    });
    // (b) inserts a fresh scheduled booking at the same slot → must succeed.
    const created = await prisma.booking.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: b.studentId,
        packageId: b.packageId,
        scheduledStart: slot,
        scheduledEnd: slotEnd,
        status: "scheduled",
      },
      select: { id: true },
    });
    expect(created.id).toBeTruthy();

    const scheduled = await prisma.booking.findMany({
      where: { teacherId: TEACHER_ID, scheduledStart: slot, status: "scheduled" },
    });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].studentId).toBe(b.studentId);
  });

  it("partial-index scope: same-slot inserts for DIFFERENT teachers don't collide (teacher_id is part of the key)", async () => {
    await seedTeacher();
    const TEACHER_2_ID = "11111111-1111-4111-8111-bbbbbbbbbbbb";
    await ensureAuthUser(TEACHER_2_ID, "teacher2-concurrent@e2e.test");
    const prisma = getTestPrisma();
    await prisma.teacher.create({
      data: {
        id: TEACHER_2_ID,
        email: "teacher2-concurrent@e2e.test",
        name: "Test Teacher 2",
        timezone: "America/Mexico_City",
        bookingSlug: "concurrent-teacher-2",
      },
    });
    const a = await seedStudentWithPackage({
      studentEmail: "student-a@multi.test",
    });
    // Make a second package whose teacher is TEACHER_2_ID for student b.
    const studentB = await prisma.student.create({
      data: { email: "student-b@multi.test", name: "B" },
      select: { id: true },
    });
    await prisma.teacherStudent.create({
      data: { teacherId: TEACHER_2_ID, studentId: studentB.id },
    });
    const pkgB = await prisma.package.create({
      data: {
        teacherId: TEACHER_2_ID,
        studentId: studentB.id,
        classesTotal: 10,
        classDurationMin: 50,
        pricePaidMinorUnits: 150_000,
        purchasedAt: new Date(),
        status: "active",
      },
      select: { id: true },
    });

    const slot = new Date("2026-08-01T16:00:00.000Z");
    const slotEnd = new Date(slot.getTime() + 50 * 60_000);
    await prisma.booking.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: a.studentId,
        packageId: a.packageId,
        scheduledStart: slot,
        scheduledEnd: slotEnd,
        status: "scheduled",
      },
    });
    // Same slot, different teacher → should succeed, no P2002.
    await expect(
      prisma.booking.create({
        data: {
          teacherId: TEACHER_2_ID,
          studentId: studentB.id,
          packageId: pkgB.id,
          scheduledStart: slot,
          scheduledEnd: slotEnd,
          status: "scheduled",
        },
      }),
    ).resolves.toBeTruthy();

    const all = await prisma.booking.findMany({
      where: { scheduledStart: slot, status: "scheduled" },
      orderBy: { teacherId: "asc" },
    });
    expect(all).toHaveLength(2);
  });

  // Bug-hunt audit (medium): the buffer re-validation (generateSlots) runs on
  // a pre-transaction snapshot read, so two concurrent bookings could each
  // pass the buffer check on stale reads and land classes closer than the
  // teacher's buffer_min — the exact-overlap unique index/EXCLUDE above don't
  // catch this because the intervals genuinely don't overlap. Migrations
  // 20260703010000 (buffer_min_snapshot + trigger-derived buffered_end) and
  // 20260703020000 (the constraint itself) close it with a buffer-aware GiST
  // EXCLUDE (`bookings_no_overlap_buffered`) over each row's own snapshotted
  // buffer. This is the authoritative real-Postgres proof —
  // nothing here is mockable at the unit level, since the whole point is that
  // a concurrent transaction's uncommitted row IS visible to the constraint
  // (unlike to a SELECT under READ COMMITTED).
  it("bookings_no_overlap_buffered: 10 concurrent inserts inside one buffer window, exactly one wins", async () => {
    await seedTeacher();
    await getTestPrisma().teacher.update({
      where: { id: TEACHER_ID },
      data: { bufferMin: 15 },
    });
    const seeded = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        seedStudentWithPackage({ studentEmail: `buf${i}@race.test` }),
      ),
    );
    const prisma = getTestPrisma();
    const anchorStart = new Date("2026-09-01T16:00:00.000Z");
    const anchorEnd = new Date(anchorStart.getTime() + 50 * 60_000);
    // Seed the anchor booking that every racer's candidate slot sits inside
    // the 15-minute buffer of (5 minutes after anchorEnd — well within 15,
    // well clear of an exact overlap).
    await prisma.booking.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: seeded[0].studentId,
        packageId: seeded[0].packageId,
        scheduledStart: anchorStart,
        scheduledEnd: anchorEnd,
        status: "scheduled",
        bufferMinSnapshot: 15,
      },
    });
    const racerStart = new Date(anchorEnd.getTime() + 5 * 60_000);
    const racerEnd = new Date(racerStart.getTime() + 50 * 60_000);

    // Every racer targets the SAME too-close slot — all must be refused, not
    // just one (this isn't a "who gets the slot" race, it's "the slot must
    // never be grantable at all" while the anchor stands).
    const results = await Promise.allSettled(
      seeded.slice(1).map((s) =>
        prisma.booking.create({
          data: {
            teacherId: TEACHER_ID,
            studentId: s.studentId,
            packageId: s.packageId,
            scheduledStart: racerStart,
            scheduledEnd: racerEnd,
            status: "scheduled",
            bufferMinSnapshot: 15,
          },
        }),
      ),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    for (const r of results) {
      const err = (r as PromiseRejectedResult).reason;
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("bookings_no_overlap_buffered");
    }

    const scheduled = await prisma.booking.findMany({
      where: { teacherId: TEACHER_ID, status: "scheduled" },
    });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].scheduledStart.toISOString()).toBe(anchorStart.toISOString());
  });

  it("bookings_no_overlap_buffered: a gap exactly equal to the buffer is allowed (boundary)", async () => {
    await seedTeacher();
    await getTestPrisma().teacher.update({
      where: { id: TEACHER_ID },
      data: { bufferMin: 10 },
    });
    const a = await seedStudentWithPackage({ studentEmail: "boundary-a@race.test" });
    const b = await seedStudentWithPackage({ studentEmail: "boundary-b@race.test" });
    const prisma = getTestPrisma();
    const start1 = new Date("2026-09-02T16:00:00.000Z");
    const end1 = new Date(start1.getTime() + 50 * 60_000);
    await prisma.booking.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: a.studentId,
        packageId: a.packageId,
        scheduledStart: start1,
        scheduledEnd: end1,
        status: "scheduled",
        bufferMinSnapshot: 10,
      },
    });
    // Starts exactly 10 minutes after the first ends — gap === buffer, not <.
    const start2 = new Date(end1.getTime() + 10 * 60_000);
    const end2 = new Date(start2.getTime() + 50 * 60_000);
    await expect(
      prisma.booking.create({
        data: {
          teacherId: TEACHER_ID,
          studentId: b.studentId,
          packageId: b.packageId,
          scheduledStart: start2,
          scheduledEnd: end2,
          status: "scheduled",
          bufferMinSnapshot: 10,
        },
      }),
    ).resolves.toBeTruthy();
  });

  it("bookings_no_overlap_buffered: different teachers with overlapping buffers don't collide", async () => {
    await seedTeacher();
    await getTestPrisma().teacher.update({
      where: { id: TEACHER_ID },
      data: { bufferMin: 30 },
    });
    const TEACHER_2_ID = "11111111-1111-4111-8111-cccccccccccc";
    await ensureAuthUser(TEACHER_2_ID, "teacher2-buffer@e2e.test");
    const prisma = getTestPrisma();
    await prisma.teacher.create({
      data: {
        id: TEACHER_2_ID,
        email: "teacher2-buffer@e2e.test",
        name: "Test Teacher 2",
        timezone: "America/Mexico_City",
        bookingSlug: "buffer-teacher-2",
        bufferMin: 30,
      },
    });
    const a = await seedStudentWithPackage({ studentEmail: "buf-t1@race.test" });
    const studentB = await prisma.student.create({
      data: { email: "buf-t2@race.test", name: "B" },
      select: { id: true },
    });
    await prisma.teacherStudent.create({
      data: { teacherId: TEACHER_2_ID, studentId: studentB.id },
    });
    const pkgB = await prisma.package.create({
      data: {
        teacherId: TEACHER_2_ID,
        studentId: studentB.id,
        classesTotal: 10,
        classDurationMin: 50,
        pricePaidMinorUnits: 150_000,
        purchasedAt: new Date(),
        status: "active",
      },
      select: { id: true },
    });

    const start = new Date("2026-09-03T16:00:00.000Z");
    const end = new Date(start.getTime() + 50 * 60_000);
    await prisma.booking.create({
      data: {
        teacherId: TEACHER_ID,
        studentId: a.studentId,
        packageId: a.packageId,
        scheduledStart: start,
        scheduledEnd: end,
        status: "scheduled",
        bufferMinSnapshot: 30,
      },
    });
    // Same interval, DIFFERENT teacher, deep inside what would be a same-
    // teacher buffer violation — must succeed (constraint is scoped per
    // teacher_id, same as the plain overlap EXCLUDE).
    await expect(
      prisma.booking.create({
        data: {
          teacherId: TEACHER_2_ID,
          studentId: studentB.id,
          packageId: pkgB.id,
          scheduledStart: start,
          scheduledEnd: end,
          status: "scheduled",
          bufferMinSnapshot: 30,
        },
      }),
    ).resolves.toBeTruthy();
  });
});
