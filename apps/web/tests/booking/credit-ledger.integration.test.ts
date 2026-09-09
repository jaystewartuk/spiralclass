import { beforeEach, expect, it } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";
import { claimNextCredit, type CreditPool } from "@/lib/booking/credit-ledger";

// Multi-package audit fix — real-DB proof that consumption is FIFO-by-expiry
// across a student's active packages, and race-safe under concurrency. The
// in-memory unit tests cover the ordering logic; this exercises the actual
// Prisma claim (the per-package field-comparison guard under a row lock) the
// way the booking transaction runs it.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";

async function ensureAuthUser(id: string, email: string) {
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    id,
    email,
  );
}

async function seedTeacherAndStudent() {
  const prisma = getTestPrisma();
  await ensureAuthUser(TEACHER_ID, "teacher-ledger@e2e.test");
  await prisma.teacher.create({
    data: {
      id: TEACHER_ID,
      email: "teacher-ledger@e2e.test",
      name: "Ledger Teacher",
      timezone: "America/Mexico_City",
      bookingSlug: "ledger-teacher",
    },
  });
  const student = await prisma.student.create({
    data: { email: "ledger-student@e2e.test", name: "Ledger Student" },
    select: { id: true },
  });
  await prisma.teacherStudent.create({
    data: { teacherId: TEACHER_ID, studentId: student.id },
  });
  return student.id;
}

async function makePackage(opts: {
  studentId: string;
  total: number;
  expiresAt: Date | null;
  purchasedAt: Date;
}) {
  return getTestPrisma().package.create({
    data: {
      teacherId: TEACHER_ID,
      studentId: opts.studentId,
      classesTotal: opts.total,
      classesUsed: 0,
      classDurationMin: 50,
      pricePaidMinorUnits: 150_000,
      purchasedAt: opts.purchasedAt,
      expiresAt: opts.expiresAt,
      status: "active",
    },
    select: { id: true },
  });
}

describeIntegration("credit ledger FIFO (real DB)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("spends the soonest-to-expire credit, leaving the newer package untouched", async () => {
    const prisma = getTestPrisma();
    const studentId = await seedTeacherAndStudent();
    const soon = await makePackage({
      studentId,
      total: 10,
      expiresAt: new Date("2026-06-20T00:00:00Z"),
      purchasedAt: new Date("2026-05-01T00:00:00Z"),
    });
    const later = await makePackage({
      studentId,
      total: 10,
      expiresAt: new Date("2026-09-01T00:00:00Z"),
      purchasedAt: new Date("2026-06-10T00:00:00Z"), // newer
    });
    const pool: CreditPool = {
      teacherId: TEACHER_ID,
      studentIds: [studentId],
      classDurationMin: 50,
    };

    const claimed = await prisma.$transaction((tx) =>
      claimNextCredit(
        tx,
        pool,
        new Date("2026-06-12T00:00:00Z"),
        prisma.package.fields.classesTotal,
      ),
    );
    expect(claimed?.packageId).toBe(soon.id);

    const [soonRow, laterRow] = await Promise.all([
      prisma.package.findUniqueOrThrow({ where: { id: soon.id }, select: { classesUsed: true } }),
      prisma.package.findUniqueOrThrow({ where: { id: later.id }, select: { classesUsed: true } }),
    ]);
    expect(soonRow.classesUsed).toBe(1);
    expect(laterRow.classesUsed).toBe(0);
  });

  it("never over-claims under concurrency: 8 racing claims against a 5-credit soonest pkg spill into the next", async () => {
    const prisma = getTestPrisma();
    const studentId = await seedTeacherAndStudent();
    const soon = await makePackage({
      studentId,
      total: 5,
      expiresAt: new Date("2026-06-20T00:00:00Z"),
      purchasedAt: new Date("2026-05-01T00:00:00Z"),
    });
    const later = await makePackage({
      studentId,
      total: 5,
      expiresAt: new Date("2026-09-01T00:00:00Z"),
      purchasedAt: new Date("2026-06-10T00:00:00Z"),
    });
    const pool: CreditPool = {
      teacherId: TEACHER_ID,
      studentIds: [studentId],
      classDurationMin: 50,
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        prisma.$transaction((tx) =>
          claimNextCredit(
            tx,
            pool,
            new Date("2026-06-12T00:00:00Z"),
            prisma.package.fields.classesTotal,
          ),
        ),
      ),
    );

    // All 8 succeed (capacity is 10 total); exactly 5 came off the soonest pkg
    // and 3 off the next — no package exceeds its classesTotal.
    const perPackage = new Map<string, number>();
    for (const r of results) {
      expect(r).not.toBeNull();
      perPackage.set(r!.packageId, (perPackage.get(r!.packageId) ?? 0) + 1);
    }
    expect(perPackage.get(soon.id)).toBe(5);
    expect(perPackage.get(later.id)).toBe(3);

    const soonRow = await prisma.package.findUniqueOrThrow({
      where: { id: soon.id },
      select: { classesUsed: true },
    });
    expect(soonRow.classesUsed).toBe(5);
  });
});
