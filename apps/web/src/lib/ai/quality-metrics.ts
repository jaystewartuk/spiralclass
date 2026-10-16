// How the model's output fares once a teacher has looked at it — the one
// quality signal the product already records, read back as a figure (D-201).
//
// Two surfaces leave a verdict beside the output they judge:
//
//   - A lesson insight (lib/lesson-notes/insights.ts) is confirmed or
//     dismissed by the teacher (docs/features/lesson-insights-reports.md,
//     "the teacher review loop"). Confirmed over decided is the model's
//     precision as the teacher sees it.
//   - A homework review draft (lib/homework/ai-review.ts) is either the draft a
//     sent feedback started from (`HomeworkFeedback.aiDraftId`) or one the
//     teacher regenerated past (`discardedAt`). Used over decided is how often a
//     draft was worth keeping.
//
// Counts only, never content — the admin sees pipeline status and figures, not
// what was said in a lesson (D-23). Test accounts are left out of every figure
//. `LessonInsight` does not record which model produced it, so this
// cannot split by model; the offline evals (lib/evals/) are the before/after
// measure for a model change.

import { NOT_TEST_ACCOUNT } from "@/lib/marketing/test-accounts";
import { prisma } from "@/lib/prisma";

export type VerdictCounts = {
  // Rows the teacher kept.
  accepted: number;
  // Rows the teacher threw out.
  rejected: number;
  // Rows nobody has judged yet.
  pending: number;
};

export type VerdictSummary = VerdictCounts & {
  // accepted / (accepted + rejected), or null when nothing has been judged —
  // a rate over zero verdicts is not 0%, it is unknown, and the card says so.
  acceptanceRate: number | null;
};

// Pure: the rate is over DECIDED rows only. Pending rows are reported but do
// not dilute it — a backlog of unreviewed insights says the teacher is behind,
// not that the model is wrong.
export function summarizeVerdicts(counts: VerdictCounts): VerdictSummary {
  const decided = counts.accepted + counts.rejected;
  return {
    ...counts,
    acceptanceRate: decided === 0 ? null : counts.accepted / decided,
  };
}

export type AiQualityMetrics = {
  insights: VerdictSummary;
  homeworkDrafts: VerdictSummary;
};

const REAL_LESSON = { booking: { teacher: NOT_TEST_ACCOUNT, student: NOT_TEST_ACCOUNT } };
const REAL_HOMEWORK = {
  attempt: { submission: { assignment: { booking: REAL_LESSON.booking } } },
};

export async function getAiQualityMetrics(): Promise<AiQualityMetrics> {
  // Dismissing clears confirmedAt and confirming clears dismissedAt
  // (lib/lesson-notes/insight-actions.ts), so the three counts partition the
  // AI rows. Teacher-authored rows are her own findings, not the model's.
  const aiInsight = { source: "ai", ...REAL_LESSON };
  const [confirmed, dismissed, pendingInsights] = await Promise.all([
    // tenancy-exempt: platform-wide AI acceptance figure for the admin overview — counts only (D-23)
    prisma.lessonInsight.count({ where: { ...aiInsight, confirmedAt: { not: null } } }),
    // tenancy-exempt: platform-wide AI acceptance figure for the admin overview — counts only (D-23)
    prisma.lessonInsight.count({
      where: { ...aiInsight, confirmedAt: null, dismissedAt: { not: null } },
    }),
    // tenancy-exempt: platform-wide AI acceptance figure for the admin overview — counts only (D-23)
    prisma.lessonInsight.count({ where: { ...aiInsight, confirmedAt: null, dismissedAt: null } }),
  ]);

  // A draft a feedback started from counts as used even if a later regenerate
  // marked it discarded — "used" is the stronger verdict.
  const [used, discarded, pendingDrafts] = await Promise.all([
    // tenancy-exempt: platform-wide AI acceptance figure for the admin overview — counts only (D-23)
    prisma.homeworkAiReviewDraft.count({
      where: { ...REAL_HOMEWORK, resultingFeedback: { some: {} } },
    }),
    // tenancy-exempt: platform-wide AI acceptance figure for the admin overview — counts only (D-23)
    prisma.homeworkAiReviewDraft.count({
      where: { ...REAL_HOMEWORK, resultingFeedback: { none: {} }, discardedAt: { not: null } },
    }),
    // tenancy-exempt: platform-wide AI acceptance figure for the admin overview — counts only (D-23)
    prisma.homeworkAiReviewDraft.count({
      where: { ...REAL_HOMEWORK, resultingFeedback: { none: {} }, discardedAt: null },
    }),
  ]);

  return {
    insights: summarizeVerdicts({
      accepted: confirmed,
      rejected: dismissed,
      pending: pendingInsights,
    }),
    homeworkDrafts: summarizeVerdicts({
      accepted: used,
      rejected: discarded,
      pending: pendingDrafts,
    }),
  };
}
