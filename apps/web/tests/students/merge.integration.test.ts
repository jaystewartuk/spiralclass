import { beforeAll, beforeEach, expect, it } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";
import { mergeRosterStudents } from "@/lib/students/merge";

// Exercises the duplicate-merge path end to end against real FK semantics:
// the duplicate's packages/bookings move to the keeper, the login link and
// roster metadata union over, the duplicate row disappears, and the
// cross-tenant / two-login guards refuse.

const TEACHER_ID = "31111111-1111-4111-8111-111111111111";
const OTHER_TEACHER_ID = "32222222-2222-4222-8222-222222222222";
const STUDENT_AUTH_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_AUTH_ID = "34444444-4444-4444-8444-444444444444";
const TEMPLATE_ID = "35555555-5555-4555-8555-555555555555";

async function ensureAuthUser(id: string, email: string) {
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    id,
    email,
  );
}

async function seedTeacher(id: string, slug: string) {
  await ensureAuthUser(id, `${slug}@e2e.test`);
  await getTestPrisma().teacher.create({
    data: {
      id,
      email: `${slug}@e2e.test`,
      name: slug,
      timezone: "America/Mexico_City",
      bookingSlug: slug,
      // A grandfathered price hangs off a template now, so the roster fixture
      // needs one to hang it off.
      ...(id === TEACHER_ID
        ? {
            packageTemplates: {
              create: {
                id: TEMPLATE_ID,
                name: "4 clases",
                classCount: 4,
                priceMinorUnits: 100_000,
              },
            },
          }
        : {}),
    },
  });
}

async function seedStudent(opts: {
  email: string;
  teacherId?: string;
  authUserId?: string;
  phoneE164?: string;
  /** grandfathering is per package — this is the price for TEMPLATE_ID. */
  agreedPriceMinorUnits?: number;
}) {
  const teacherId = opts.teacherId ?? TEACHER_ID;
  return getTestPrisma().student.create({
    data: {
      email: opts.email,
      name: opts.email.split("@")[0],
      authUserId: opts.authUserId ?? null,
      phoneE164: opts.phoneE164 ?? null,
      teacherStudents: {
        create: {
          teacherId,
          ...(opts.agreedPriceMinorUnits === undefined
            ? {}
            : {
                templatePrices: {
                  create: {
                    templateId: TEMPLATE_ID,
                    priceMinorUnits: opts.agreedPriceMinorUnits,
                  },
                },
              }),
        },
      },
    },
  });
}

// `dayOffset` keeps each seeded booking on a distinct day. Both bookings end up
// on the keeper (same teacher) after the merge, so they must not overlap — the
// `bookings_no_overlap_active` exclusion constraint (migration
// 20260617000000) rejects two overlapping 'scheduled' bookings per teacher.
async function seedPackageWithBooking(studentId: string, dayOffset = 1) {
  const prisma = getTestPrisma();
  const pkg = await prisma.package.create({
    data: {
      teacherId: TEACHER_ID,
      studentId,
      classesTotal: 4,
      classesUsed: 1,
      pricePaidMinorUnits: 130_000,
      purchasedAt: new Date(),
      status: "active",
    },
  });
  const start = Date.now() + dayOffset * 86_400_000;
  await prisma.booking.create({
    data: {
      packageId: pkg.id,
      teacherId: TEACHER_ID,
      studentId,
      scheduledStart: new Date(start),
      scheduledEnd: new Date(start + 50 * 60_000),
      status: "scheduled",
    },
  });
  return pkg;
}

describeIntegration("mergeRosterStudents (real DB)", () => {
  beforeAll(async () => {
    await truncateAll();
  });
  beforeEach(async () => {
    await truncateAll();
    await seedTeacher(TEACHER_ID, "merge-teacher");
  });

  it("moves packages/bookings/login to the keeper, unions metadata, deletes the duplicate", async () => {
    const prisma = getTestPrisma();
    await ensureAuthUser(STUDENT_AUTH_ID, "mira@gmail.com");

    // Keeper: typo'd email row that took the payment (the observed case has
    // the data on one side and the login on the other — model the harder
    // direction: keeper has history, duplicate has the login + metadata).
    const keep = await seedStudent({ email: "mira@gmail.com" });
    await seedPackageWithBooking(keep.id, 1);

    const dup = await seedStudent({
      email: "mira@gmial.com",
      authUserId: STUDENT_AUTH_ID,
      phoneE164: "+5215555000001",
      agreedPriceMinorUnits: 90_000,
    });
    await seedPackageWithBooking(dup.id, 2);
    await prisma.notification.create({
      data: {
        teacherId: TEACHER_ID,
        recipientType: "student",
        recipientId: dup.id,
        channel: "email",
        templateName: "booking_confirmation_student",
        status: "sent",
      },
    });

    const result = await mergeRosterStudents(
      { teacherId: TEACHER_ID, keepStudentId: keep.id, mergeStudentId: dup.id },
      prisma,
    );

    expect(result).toMatchObject({
      ok: true,
      moved: {
        packages: 1,
        bookings: 1,
        notifications: 1,
        authUserMoved: true,
      },
    });

    expect(await prisma.student.findUnique({ where: { id: dup.id } })).toBeNull();

    const survivor = await prisma.student.findUniqueOrThrow({ where: { id: keep.id } });
    expect(survivor.authUserId).toBe(STUDENT_AUTH_ID);
    expect(survivor.phoneE164).toBe("+5215555000001");

    expect(await prisma.package.count({ where: { studentId: keep.id } })).toBe(2);
    expect(await prisma.booking.count({ where: { studentId: keep.id } })).toBe(2);
    expect(
      await prisma.notification.count({
        where: { recipientType: "student", recipientId: keep.id },
      }),
    ).toBe(1);

    // The duplicate's agreed price moves to the keeper, per package.
    const agreed = await prisma.teacherStudentTemplatePrice.findUniqueOrThrow({
      where: {
        teacherId_studentId_templateId: {
          teacherId: TEACHER_ID,
          studentId: keep.id,
          templateId: TEMPLATE_ID,
        },
      },
    });
    expect(agreed.priceMinorUnits).toBe(90_000);

    const audit = await prisma.override.findFirst({
      where: { teacherId: TEACHER_ID, action: "merge_students" },
    });
    expect(audit?.targetId).toBe(keep.id);
  });

  it("refuses when the duplicate is enrolled with another teacher", async () => {
    const prisma = getTestPrisma();
    await seedTeacher(OTHER_TEACHER_ID, "merge-other-teacher");

    const keep = await seedStudent({ email: "mira@gmail.com" });
    const dup = await seedStudent({ email: "mira@gmial.com" });
    await prisma.teacherStudent.create({
      data: { teacherId: OTHER_TEACHER_ID, studentId: dup.id },
    });

    const result = await mergeRosterStudents(
      { teacherId: TEACHER_ID, keepStudentId: keep.id, mergeStudentId: dup.id },
      prisma,
    );
    expect(result).toEqual({ ok: false, code: "other_teacher" });
    expect(await prisma.student.findUnique({ where: { id: dup.id } })).not.toBeNull();
  });

  it("refuses when both rows have signed in as different auth users", async () => {
    await ensureAuthUser(STUDENT_AUTH_ID, "mira@gmail.com");
    await ensureAuthUser(OTHER_AUTH_ID, "ana2@gmail.com");

    const keep = await seedStudent({ email: "mira@gmail.com", authUserId: STUDENT_AUTH_ID });
    const dup = await seedStudent({ email: "mira@gmial.com", authUserId: OTHER_AUTH_ID });

    const result = await mergeRosterStudents(
      { teacherId: TEACHER_ID, keepStudentId: keep.id, mergeStudentId: dup.id },
      getTestPrisma(),
    );
    expect(result).toEqual({ ok: false, code: "two_logins" });
  });

  it("refuses students that aren't on the caller's roster", async () => {
    await seedTeacher(OTHER_TEACHER_ID, "merge-other-teacher");
    const keep = await seedStudent({ email: "mira@gmail.com" });
    const foreign = await seedStudent({
      email: "mira@gmial.com",
      teacherId: OTHER_TEACHER_ID,
    });

    const result = await mergeRosterStudents(
      { teacherId: TEACHER_ID, keepStudentId: keep.id, mergeStudentId: foreign.id },
      getTestPrisma(),
    );
    expect(result).toEqual({ ok: false, code: "not_on_roster" });
  });
});
