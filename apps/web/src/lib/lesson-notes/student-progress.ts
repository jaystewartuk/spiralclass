import type { PrismaClient } from "@prisma/client";

import { profileSchema, type StudentProfile } from "./profile";
import { scheduleNext, seedVocabularyReviews, type Grade } from "./srs";
import { attachVocabContext } from "./vocab-context";

// Read/grade core for the student "Your progress" surface (Phase F2), kept out
// of the page so the framing + SRS scheduling have one definition. App-scoped
// to the signed-in student's identity set by the
// caller (every student read/write passes `ids`).

export type StudentProgressTeacher = {
  teacherId: string;
  teacherName: string;
  improving: string[];
  practise: string[];
};

export type StudentProgressView = {
  teachers: StudentProgressTeacher[];
  // `context` (D-97, flashcard flip side) is the confirming lesson's
  // evidence/suggestion, when one can be matched — see vocab-context.ts.
  vocabulary: { id: string; term: string; context: string | null }[];
};

// Encouragement framing: improving (celebrate) vs keep-practising (focus + new),
// as plain skill labels.
function framing(profile: StudentProfile): { improving: string[]; practise: string[] } {
  const improving: string[] = [];
  const practise: string[] = [];
  for (const skills of Object.values(profile.byCategory)) {
    for (const [skill, entry] of Object.entries(skills)) {
      const label = skill.replace(/_/g, " ");
      if (entry.trend === "improving") improving.push(label);
      else practise.push(label);
    }
  }
  return { improving, practise };
}

// Load the student's shared progress: per-teacher framing + the due vocab queue.
// Seeds the SRS queue lazily from each shared profile (no-op for terms already
// scheduled — preserves review progress).
export async function loadStudentProgress(
  prisma: PrismaClient,
  ids: string[],
  now: Date,
): Promise<StudentProgressView> {
  if (ids.length === 0) return { teachers: [], vocabulary: [] };

  const shared = await prisma.teacherStudent.findMany({
    where: { studentId: { in: ids }, shareProgress: true },
    select: { teacherId: true, studentId: true, teacher: { select: { name: true } } },
  });

  const profiles = shared.length
    ? await prisma.studentLearningProfile.findMany({
        where: { OR: shared.map((s) => ({ teacherId: s.teacherId, studentId: s.studentId })) },
        select: { teacherId: true, studentId: true, profile: true },
      })
    : [];

  for (const row of profiles) {
    const parsed = profileSchema.safeParse(row.profile);
    if (!parsed.success) continue;
    const terms = parsed.data.vocabulary.map((v) => v.term);
    if (terms.length) {
      await seedVocabularyReviews(prisma, {
        teacherId: row.teacherId,
        studentId: row.studentId,
        terms,
        now,
      });
    }
  }

  const due = await prisma.vocabularyReview.findMany({
    where: { studentId: { in: ids }, dueAt: { lte: now } },
    select: { id: true, term: true, teacherId: true, studentId: true },
    orderBy: { dueAt: "asc" },
    take: 50,
  });
  const vocabulary = await attachVocabContext(prisma, due);

  const teacherName = new Map(shared.map((s) => [s.teacherId, s.teacher.name]));
  const teachers = profiles
    .map((row): StudentProgressTeacher | null => {
      const parsed = profileSchema.safeParse(row.profile);
      if (!parsed.success) return null;
      return {
        teacherId: row.teacherId,
        teacherName: teacherName.get(row.teacherId) ?? "",
        ...framing(parsed.data),
      };
    })
    .filter((v): v is StudentProgressTeacher => v !== null)
    .filter((v) => v.improving.length > 0 || v.practise.length > 0);

  return { teachers, vocabulary };
}

// Grade a due term and reschedule it (SM-2). Scoped to the student's identity
// set — a student can only touch their own review rows.
export async function gradeVocabularyFor(
  prisma: PrismaClient,
  ids: string[],
  reviewId: string,
  grade: Grade,
): Promise<{ ok: true } | { ok: false; reason: "not-found" | "save-failed" }> {
  const review = await prisma.vocabularyReview.findFirst({
    where: { id: reviewId, studentId: { in: ids } },
    select: { id: true, intervalDays: true, easeFactor: true },
  });
  if (!review) return { ok: false, reason: "not-found" };

  const next = scheduleNext(
    { intervalDays: review.intervalDays, easeFactor: review.easeFactor },
    grade,
    new Date(),
  );

  try {
    await prisma.vocabularyReview.update({
      where: { id: review.id },
      data: {
        intervalDays: next.intervalDays,
        easeFactor: next.easeFactor,
        dueAt: next.dueAt,
        lastReviewedAt: new Date(),
      },
    });
  } catch {
    return { ok: false, reason: "save-failed" };
  }
  return { ok: true };
}
