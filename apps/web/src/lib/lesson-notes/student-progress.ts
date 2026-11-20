import type { PrismaClient } from "@prisma/client";

import { scheduleNext, type Grade } from "./srs";

// Grading core for the student "Your progress" surface (Phase F2), kept out of
// the page so the SRS scheduling has one definition. App-scoped to the
// signed-in student's identity set by the caller (every student write passes
// `ids`).

// The most cards one visit to "Your progress" shows.
export const DUE_CARDS_PER_VISIT = 50;

// A flashcard as the student sees it: the term, and nothing else. Its back is
// deliberately not built from the LessonInsight the term came from — that
// row's evidence and suggestion are written to the teacher, in her reading
// language, about the student (#302; docs/features/lesson-insights-reports.md,
// "What the student sees").
export type DueCard = { id: string; term: string };

// The student's due cards, from the pairings whose progress is shared right
// now and from no other. `shared` is the caller's read of
// `TeacherStudent.shareProgress`; a term seeded while sharing was on stops
// appearing the moment it is turned off, and comes back with its schedule
// intact if it is turned on again.
export async function dueVocabularyFor(
  prisma: Pick<PrismaClient, "vocabularyReview">,
  ids: string[],
  shared: { teacherId: string; studentId: string }[],
  now: Date,
): Promise<DueCard[]> {
  if (ids.length === 0 || shared.length === 0) return [];
  return prisma.vocabularyReview.findMany({
    where: {
      studentId: { in: ids },
      dueAt: { lte: now },
      OR: shared.map((s) => ({ teacherId: s.teacherId, studentId: s.studentId })),
    },
    select: { id: true, term: true },
    orderBy: { dueAt: "asc" },
    take: DUE_CARDS_PER_VISIT,
  });
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
      where: { id: review.id, studentId: { in: ids } },
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
