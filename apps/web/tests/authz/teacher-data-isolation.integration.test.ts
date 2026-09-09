import { beforeEach, expect, it, describe } from "vitest";
import { describeIntegration, getTestPrisma, truncateAll } from "../_setup/test-db";
import {
  confirmInsightFor,
  editInsightFor,
  dismissInsightFor,
  addInsightFor,
} from "@/lib/lesson-notes/insight-actions";
import { gradeVocabularyFor } from "@/lib/lesson-notes/student-progress";

// App-layer tenancy authz — replaces the DB-level owner-RLS integration tests
// retired in the Supabase→Neon migration (#530). Those asserted Postgres RLS
// scoped teacher-private rows; that enforcement is gone, and the request path
// now queries through the privileged Prisma client (see lib/prisma.ts). The
// real backstop is each accessor's own `where { teacherId }` / `where { id,
// teacherId }` gate — so THAT is what these exercise: seed two tenants, act as
// the wrong one, and assert the gate rejects it (and the victim's row is
// untouched). A regression that drops a scoping clause fails here.
//
// Seeds through the better-auth `user` table (Teacher.id shares its PK, D-40).

const TEACHER_A = "a1111111-1111-4111-8111-111111111111";
const TEACHER_B = "b2222222-2222-4222-8222-222222222222";
const STUDENT_A_AUTH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STUDENT_B_AUTH = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function ensureUserRow(id: string, email: string) {
  await getTestPrisma().$executeRawUnsafe(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1::uuid, split_part($2, '@', 1), $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
    id,
    email,
  );
}

// Seeds one teacher + one student + a completed booking, returns their ids.
async function seedTenant(opts: {
  teacherId: string;
  slug: string;
  studentAuthId: string;
}): Promise<{ studentId: string; bookingId: string }> {
  const prisma = getTestPrisma();
  await ensureUserRow(opts.teacherId, `${opts.slug}-teacher@e2e.test`);
  await ensureUserRow(opts.studentAuthId, `${opts.slug}-student@e2e.test`);
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
  const pkg = await prisma.package.create({
    data: {
      teacherId: opts.teacherId,
      studentId: student.id,
      classesTotal: 10,
      classDurationMin: 50,
      pricePaidMinorUnits: 150_000,
      purchasedAt: new Date("2026-06-01T00:00:00Z"),
      status: "active",
    },
    select: { id: true },
  });
  const booking = await prisma.booking.create({
    data: {
      packageId: pkg.id,
      teacherId: opts.teacherId,
      studentId: student.id,
      scheduledStart: new Date("2026-06-23T15:00:00Z"),
      scheduledEnd: new Date("2026-06-23T15:50:00Z"),
      status: "completed",
    },
    select: { id: true },
  });
  return { studentId: student.id, bookingId: booking.id };
}

describeIntegration("app-layer teacher data isolation (real DB)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  describe("lessonInsight — the ownedInsight teacher gate", () => {
    it("a teacher cannot confirm / edit / dismiss another teacher's insight", async () => {
      const prisma = getTestPrisma();
      const a = await seedTenant({
        teacherId: TEACHER_A,
        slug: "alpha",
        studentAuthId: STUDENT_A_AUTH,
      });
      await seedTenant({ teacherId: TEACHER_B, slug: "beta", studentAuthId: STUDENT_B_AUTH });

      const insight = await prisma.lessonInsight.create({
        data: {
          bookingId: a.bookingId,
          teacherId: TEACHER_A,
          category: "grammar",
          summary: "Confuses ser/estar",
          source: "ai",
        },
        select: { id: true },
      });

      // Teacher B targets teacher A's insight by id — every op is rejected.
      expect(await confirmInsightFor(prisma, TEACHER_B, insight.id)).toEqual({
        ok: false,
        reason: "not-found",
      });
      expect(await editInsightFor(prisma, TEACHER_B, insight.id, { summary: "hijacked" })).toEqual({
        ok: false,
        reason: "not-found",
      });
      expect(await dismissInsightFor(prisma, TEACHER_B, insight.id)).toEqual({
        ok: false,
        reason: "not-found",
      });

      // A's row is completely untouched by B's attempts.
      const row = await prisma.lessonInsight.findUnique({
        where: { id: insight.id },
        select: { summary: true, confirmedAt: true, dismissedAt: true },
      });
      expect(row).toMatchObject({
        summary: "Confuses ser/estar",
        confirmedAt: null,
        dismissedAt: null,
      });
    });

    it("the owning teacher CAN confirm their own insight (gate isn't blanket-deny)", async () => {
      const prisma = getTestPrisma();
      const a = await seedTenant({
        teacherId: TEACHER_A,
        slug: "alpha",
        studentAuthId: STUDENT_A_AUTH,
      });
      const insight = await prisma.lessonInsight.create({
        data: {
          bookingId: a.bookingId,
          teacherId: TEACHER_A,
          category: "grammar",
          summary: "ser/estar",
          source: "ai",
        },
        select: { id: true },
      });

      const res = await confirmInsightFor(prisma, TEACHER_A, insight.id);
      expect(res.ok).toBe(true);
      const row = await prisma.lessonInsight.findUnique({
        where: { id: insight.id },
        select: { confirmedAt: true },
      });
      expect(row?.confirmedAt).not.toBeNull();
    });

    it("a teacher cannot add an insight to another teacher's booking", async () => {
      const prisma = getTestPrisma();
      const a = await seedTenant({
        teacherId: TEACHER_A,
        slug: "alpha",
        studentAuthId: STUDENT_A_AUTH,
      });
      await seedTenant({ teacherId: TEACHER_B, slug: "beta", studentAuthId: STUDENT_B_AUTH });

      // Booking-ownership gate: the same pattern the booking-keyed private
      // tables (lesson_audio / briefs / transcripts) rely on upstream.
      const res = await addInsightFor(prisma, TEACHER_B, a.bookingId, {
        category: "grammar",
        summary: "injected into A's lesson",
      });
      expect(res).toEqual({ ok: false, reason: "not-found" });
      expect(await prisma.lessonInsight.count({ where: { bookingId: a.bookingId } })).toBe(0);
    });
  });

  describe("vocabularyReview — the gradeVocabularyFor student gate", () => {
    it("a student cannot grade another student's vocabulary review", async () => {
      const prisma = getTestPrisma();
      const a = await seedTenant({
        teacherId: TEACHER_A,
        slug: "alpha",
        studentAuthId: STUDENT_A_AUTH,
      });
      const b = await seedTenant({
        teacherId: TEACHER_B,
        slug: "beta",
        studentAuthId: STUDENT_B_AUTH,
      });

      const review = await prisma.vocabularyReview.create({
        data: {
          teacherId: TEACHER_A,
          studentId: a.studentId,
          term: "la sobremesa",
          dueAt: new Date("2026-06-25T12:00:00Z"),
        },
        select: { id: true, dueAt: true },
      });

      // Student B's identity set can't touch student A's review row.
      expect(await gradeVocabularyFor(prisma, [b.studentId], review.id, "good")).toEqual({
        ok: false,
        reason: "not-found",
      });
      const untouched = await prisma.vocabularyReview.findUnique({
        where: { id: review.id },
        select: { intervalDays: true, lastReviewedAt: true },
      });
      expect(untouched).toMatchObject({ intervalDays: 0, lastReviewedAt: null });

      // Student A can grade their own — reschedules it.
      expect(await gradeVocabularyFor(prisma, [a.studentId], review.id, "good")).toEqual({
        ok: true,
      });
      const graded = await prisma.vocabularyReview.findUnique({
        where: { id: review.id },
        select: { lastReviewedAt: true },
      });
      expect(graded?.lastReviewedAt).not.toBeNull();
    });
  });
});
