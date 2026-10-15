import type { PrismaClient } from "@prisma/client";

import { scheduleNext, type Grade } from "./srs";

// Grading core for the student "Your progress" surface (Phase F2), kept out of
// the page so the SRS scheduling has one definition. App-scoped to the
// signed-in student's identity set by the caller (every student write passes
// `ids`).

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
