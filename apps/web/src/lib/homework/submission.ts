import "server-only";

import type {
  Assignment,
  HomeworkAiReviewDraft,
  HomeworkAttempt,
  HomeworkFeedback,
  HomeworkSubmission,
  HomeworkSubmissionFile,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type SubmissionWithFiles = HomeworkSubmission & { files: HomeworkSubmissionFile[] };

export type AttemptWithFilesAndFeedback = HomeworkAttempt & {
  files: HomeworkSubmissionFile[];
  feedback: HomeworkFeedback | null;
  aiReviewDrafts: HomeworkAiReviewDraft[];
};

// Load a student's submission for an assignment (with its files), or null when
// they haven't started one yet. The (assignmentId, studentId) pair is unique, so
// this is a single indexed lookup.
export function findSubmission(
  assignmentId: string,
  studentId: string,
): Promise<SubmissionWithFiles | null> {
  return prisma.homeworkSubmission.findUnique({
    where: { assignmentId_studentId: { assignmentId, studentId } },
    include: { files: true },
  });
}

// Get-or-create the student's DRAFT submission row for an assignment. Used by
// the draft-save and file-attach paths, which both need a submission to hang
// their content on. Idempotent: an existing row (in any status) is returned
// as-is — never silently reset to draft. Uses upsert so two near-simultaneous
// autosaves can't race a unique-constraint violation.
export async function ensureSubmission(
  assignment: Pick<Assignment, "id" | "teacherId">,
  studentId: string,
): Promise<SubmissionWithFiles> {
  return prisma.homeworkSubmission.upsert({
    where: { assignmentId_studentId: { assignmentId: assignment.id, studentId } },
    create: {
      assignmentId: assignment.id,
      studentId,
      teacherId: assignment.teacherId,
      status: "draft",
    },
    update: {},
    include: { files: true },
  });
}

// The teacher's feedback on a submission's most recent attempt, or null when
// there is none yet (no attempts, or the latest attempt hasn't been reviewed).
// Used to surface "your latest feedback" on the student assignment-detail
// screen without the student needing the full attempt history.
export function latestFeedbackForSubmission(
  submissionId: string,
): Promise<HomeworkFeedback | null> {
  return prisma.homeworkFeedback.findFirst({
    where: { attempt: { submissionId } },
    orderBy: { attempt: { attemptNumber: "desc" } },
  });
}

// All attempts (the append-only submit history) for a TEACHER-owned
// assignment, newest first — the review screen's data source on both
// platforms. SpiralClass is strictly 1-on-1 tutoring (D-88), so an assignment
// has at most one HomeworkSubmission; this is that submission's full attempt
// history, not a per-student list.
export function attemptsForAssignment(
  assignmentId: string,
): Promise<AttemptWithFilesAndFeedback[]> {
  return prisma.homeworkAttempt.findMany({
    where: { submission: { assignmentId } },
    orderBy: { attemptNumber: "desc" },
    include: { files: true, feedback: true, aiReviewDrafts: { orderBy: { createdAt: "desc" } } },
  });
}
