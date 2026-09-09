import { beforeEach, expect, it } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";
import { seedVocabularyReviews } from "@/lib/lesson-notes/srs";

// Phase F, Half 2.
// vocabulary_reviews is teacher-private (scoped at the app layer by teacherId —
// the DB-level owner-RLS test was retired with Supabase; see the Neon migration
// notes); seeding preserves existing scheduling state (the SRS-outside-the-profile
// constraint); and the share toggle gates which profiles a student can read.

const TEACHER_A = "11111111-1111-4111-8111-111111111111";
const STUDENT_A_AUTH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function ensureAuthUser(id: string, email: string) {
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    id,
    email,
  );
}

async function seedPair(opts: {
  teacherId: string;
  slug: string;
  studentAuthId: string;
}): Promise<string> {
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
  await prisma.teacherStudent.create({
    data: { teacherId: opts.teacherId, studentId: student.id },
  });
  return student.id;
}

const NOW = new Date("2026-06-25T12:00:00Z");

describeIntegration("vocabulary_reviews + share gating (real DB)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("seeding is idempotent and preserves existing scheduling state", async () => {
    const prisma = getTestPrisma();
    const studentId = await seedPair({
      teacherId: TEACHER_A,
      slug: "alpha",
      studentAuthId: STUDENT_A_AUTH,
    });

    await seedVocabularyReviews(prisma, {
      teacherId: TEACHER_A,
      studentId,
      terms: ["la sobremesa"],
      now: NOW,
    });
    // Advance the term's schedule (as a review would).
    await prisma.vocabularyReview.updateMany({
      where: { teacherId: TEACHER_A, studentId, term: "la sobremesa" },
      data: { intervalDays: 6, dueAt: new Date("2026-07-01T12:00:00Z") },
    });
    // Re-seed (same term + a new one): existing term untouched, new term added.
    await seedVocabularyReviews(prisma, {
      teacherId: TEACHER_A,
      studentId,
      terms: ["la sobremesa", "el madrugón"],
      now: NOW,
    });

    const rows = await prisma.vocabularyReview.findMany({
      where: { studentId },
      select: { term: true, intervalDays: true },
    });
    const byTerm = new Map(rows.map((r) => [r.term, r.intervalDays]));
    expect(rows).toHaveLength(2);
    expect(byTerm.get("la sobremesa")).toBe(6); // preserved, not reset to 0
    expect(byTerm.get("el madrugón")).toBe(0); // freshly seeded
  });

  it("the share toggle gates which profiles a student can read (app-scoped)", async () => {
    const prisma = getTestPrisma();
    const studentId = await seedPair({
      teacherId: TEACHER_A,
      slug: "alpha",
      studentAuthId: STUDENT_A_AUTH,
    });
    await prisma.studentLearningProfile.create({
      data: { teacherId: TEACHER_A, studentId, profile: { byCategory: {}, vocabulary: [] } },
    });

    // Not shared yet → the student-side query (shareProgress filter) returns nothing.
    const notShared = await prisma.teacherStudent.findMany({
      where: { studentId, shareProgress: true },
    });
    expect(notShared).toHaveLength(0);

    await prisma.teacherStudent.update({
      where: { teacherId_studentId: { teacherId: TEACHER_A, studentId } },
      data: { shareProgress: true },
    });
    const shared = await prisma.teacherStudent.findMany({
      where: { studentId, shareProgress: true },
    });
    expect(shared).toHaveLength(1);
  });
});
