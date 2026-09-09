import { beforeEach, expect, it } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";
import { recomputeStudentProfile } from "@/lib/lesson-notes/profile";

// Phase E. The
// learning profile is teacher-private (scoped at the app layer by teacherId —
// the DB-level owner-RLS test was retired with Supabase; see the Neon migration
// notes), only CONFIRMED insights feed it, and a teacher confirmation survives
// Phase C's idempotent re-gen.

const TEACHER_A = "11111111-1111-4111-8111-111111111111";
const STUDENT_A_AUTH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function ensureAuthUser(id: string, email: string) {
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    id,
    email,
  );
}

async function seed(opts: {
  teacherId: string;
  slug: string;
  studentAuthId: string;
}): Promise<{ studentId: string; bookingId: string }> {
  const prisma = getTestPrisma();
  await ensureAuthUser(opts.teacherId, `${opts.slug}-teacher@e2e.test`);
  await ensureAuthUser(opts.studentAuthId, `${opts.slug}-student@e2e.test`);
  await prisma.teacher.create({
    data: {
      id: opts.teacherId,
      email: `${opts.slug}-teacher@e2e.test`,
      name: `${opts.slug} teacher`,
      timezone: "America/Mexico_City",
      bookingSlug: opts.slug,
    },
  });
  const student = await prisma.student.create({
    data: {
      email: `${opts.slug}-student@e2e.test`,
      name: "Student",
      authUserId: opts.studentAuthId,
    },
    select: { id: true },
  });
  const pkg = await prisma.package.create({
    data: {
      teacherId: opts.teacherId,
      studentId: student.id,
      classesTotal: 10,
      classesUsed: 0,
      classDurationMin: 50,
      pricePaidMinorUnits: 150_000,
      purchasedAt: new Date("2026-06-01T00:00:00Z"),
      expiresAt: null,
      status: "active",
    },
    select: { id: true },
  });
  const booking = await prisma.booking.create({
    data: {
      packageId: pkg.id,
      teacherId: opts.teacherId,
      studentId: student.id,
      scheduledStart: new Date("2026-06-15T15:00:00Z"),
      scheduledEnd: new Date("2026-06-15T15:50:00Z"),
      status: "completed",
    },
    select: { id: true },
  });
  return { studentId: student.id, bookingId: booking.id };
}

describeIntegration("lesson insights Phase E (real DB)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("recompute rolls up ONLY confirmed insights into the profile", async () => {
    const prisma = getTestPrisma();
    const { studentId, bookingId } = await seed({
      teacherId: TEACHER_A,
      slug: "alpha",
      studentAuthId: STUDENT_A_AUTH,
    });
    await prisma.lessonInsight.createMany({
      data: [
        {
          bookingId,
          teacherId: TEACHER_A,
          category: "grammar",
          summary: "ser/estar",
          skill: "ser_vs_estar",
          source: "ai",
          confirmedAt: new Date("2026-06-15T16:00:00Z"),
        },
        {
          bookingId,
          teacherId: TEACHER_A,
          category: "grammar",
          summary: "subjuntivo",
          skill: "subjunctive",
          source: "ai",
        }, // unconfirmed
        {
          bookingId,
          teacherId: TEACHER_A,
          category: "fluency",
          summary: "muchos titubeos",
          skill: "hesitation",
          source: "ai",
          dismissedAt: new Date("2026-06-15T16:00:00Z"),
        }, // dismissed
      ],
    });

    await recomputeStudentProfile(prisma, { teacherId: TEACHER_A, studentId });

    const row = await prisma.studentLearningProfile.findUnique({
      where: { teacherId_studentId: { teacherId: TEACHER_A, studentId } },
      select: { profile: true },
    });
    const profile = row!.profile as any;
    expect(Object.keys(profile.byCategory)).toEqual(["grammar"]);
    expect(profile.byCategory.grammar.ser_vs_estar.recurrenceCount).toBe(1);
    expect(profile.byCategory.grammar.subjunctive).toBeUndefined(); // unconfirmed excluded
    expect(profile.byCategory.fluency).toBeUndefined(); // dismissed excluded
  });

  it("a confirmed insight survives Phase C's idempotent re-gen", async () => {
    const prisma = getTestPrisma();
    const { bookingId } = await seed({
      teacherId: TEACHER_A,
      slug: "alpha",
      studentAuthId: STUDENT_A_AUTH,
    });
    await prisma.lessonInsight.createMany({
      data: [
        {
          bookingId,
          teacherId: TEACHER_A,
          category: "grammar",
          summary: "confirmed one",
          source: "ai",
          confirmedAt: new Date(),
        },
        { bookingId, teacherId: TEACHER_A, category: "grammar", summary: "stale ai", source: "ai" },
      ],
    });

    // C re-gen deletes only source='ai' AND confirmedAt IS NULL.
    await prisma.lessonInsight.deleteMany({
      where: { bookingId, source: "ai", confirmedAt: null },
    });

    const remaining = await prisma.lessonInsight.findMany({
      where: { bookingId },
      select: { summary: true },
    });
    expect(remaining.map((r) => r.summary)).toEqual(["confirmed one"]);
  });
});
