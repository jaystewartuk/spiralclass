// Homework domain constants (docs/features/homework.md).

// Per-teacher monthly cap on "Review with AI" / "Regenerate" calls (slice 5),
// counted directly from HomeworkAiReviewDraft rows — same shape as
// CLASS_CONTENT_AI_MONTHLY_CAP (lib/materials/config.ts), a separate quota
// since it's a distinct Pro feature/gate ("homework_review", not
// "class_content"). Generous for normal review volume; a teacher who hits it
// can still review and grade by hand — AI assist is never required to grade.
export const HOMEWORK_AI_REVIEW_MONTHLY_CAP = 100;

// Bound on the free-text per-request steer a teacher gives "Review with AI"
// (e.g. "focus on the subjunctive mood") — a sentence or two, not a document.
export const HOMEWORK_AI_REVIEW_INSTRUCTIONS_MAX_CHARS = 500;
