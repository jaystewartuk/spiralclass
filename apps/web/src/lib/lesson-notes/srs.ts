import type { PrismaClient } from "@prisma/client";

// Vocabulary spaced repetition — Phase F, Half 2
//. A classic SM-2-style scheduler
// (pure, unit-tested) plus seeding from the profile's vocabulary queue. SRS state
// lives in VocabularyReview, NOT in the recomputed profile JSON (which is
// clobbered on every E mutation) — this is the Phase-F cross-phase constraint.

export const GRADES = ["again", "hard", "good", "easy"] as const;
export type Grade = (typeof GRADES)[number];

export const MIN_EASE = 1.3;
export const DEFAULT_EASE = 2.5;
const AGAIN_MINUTES = 10; // re-show a lapsed term shortly, within the session
const DAY_MS = 24 * 60 * 60 * 1000;

// SM-2 quality per grade (0–5 scale).
const QUALITY: Record<Grade, number> = { again: 1, hard: 3, good: 4, easy: 5 };

export type ReviewState = { intervalDays: number; easeFactor: number };
export type NextReview = { intervalDays: number; easeFactor: number; dueAt: Date };

// Compute the next schedule for a term given the teacher/student grade. Pure:
// `now` is injected. "again" resets the interval and re-shows the term soon; the
// ease factor floors at MIN_EASE.
export function scheduleNext(state: ReviewState, grade: Grade, now: Date): NextReview {
  const q = QUALITY[grade];
  // Standard SM-2 ease update; harder grades shrink it, easy grows it.
  const easeFactor = Math.max(
    MIN_EASE,
    Number((state.easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))).toFixed(4)),
  );

  let intervalDays: number;
  if (grade === "again") {
    intervalDays = 0;
  } else if (state.intervalDays <= 0) {
    // First successful review.
    intervalDays = grade === "easy" ? 4 : 1;
  } else if (state.intervalDays === 1) {
    intervalDays = grade === "hard" ? 1 : 6;
  } else {
    const multiplier = grade === "hard" ? 1.2 : easeFactor;
    intervalDays = Math.max(1, Math.round(state.intervalDays * multiplier));
  }

  const dueAt =
    grade === "again"
      ? new Date(now.getTime() + AGAIN_MINUTES * 60 * 1000)
      : new Date(now.getTime() + intervalDays * DAY_MS);

  return { intervalDays, easeFactor, dueAt };
}

type Db = Pick<PrismaClient, "vocabularyReview">;

// Seed/top-up review rows from the profile's vocabulary queue. New terms become
// due-now rows with default scheduling; existing terms are left untouched
// (skipDuplicates), so review progress survives an E profile recompute.
export async function seedVocabularyReviews(
  prisma: Db,
  args: { teacherId: string; studentId: string; terms: string[]; now: Date },
): Promise<number> {
  const terms = [...new Set(args.terms.map((t) => t.trim()).filter(Boolean))];
  if (terms.length === 0) return 0;
  const result = await prisma.vocabularyReview.createMany({
    data: terms.map((term) => ({
      teacherId: args.teacherId,
      studentId: args.studentId,
      term,
      dueAt: args.now,
    })),
    skipDuplicates: true,
  });
  return result.count;
}
