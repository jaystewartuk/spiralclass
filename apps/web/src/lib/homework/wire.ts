import "server-only";

import type {
  Assignment,
  HomeworkAiReviewDraft as PrismaAiReviewDraft,
  HomeworkAttempt as PrismaAttempt,
  HomeworkFeedback as PrismaFeedback,
  HomeworkSubmission as PrismaSubmission,
  HomeworkSubmissionFile as PrismaSubmissionFile,
} from "@prisma/client";
import type {
  HomeworkAiReviewContent,
  HomeworkAiReviewDraft,
  HomeworkAssignmentDetail,
  HomeworkAssignmentSummary,
  HomeworkAttempt,
  HomeworkFeedback,
  HomeworkSubmission,
  HomeworkSubmissionFile,
  HomeworkSubmissionStatus,
  TeacherAssignment,
} from "@spiralclass/shared";
import { mintSubmissionSignedUrl } from "@/lib/storage/homework-file";

// Is a submitted hand-in late? Only meaningful once submitted and only when the
// assignment has a due date. Uses the submission's frozen `submittedAt`, not
// "now", so lateness is stable after the fact.
export function isSubmissionLate(submittedAt: Date | null, dueAt: Date | null): boolean {
  if (!submittedAt || !dueAt) return false;
  return submittedAt.getTime() > dueAt.getTime();
}

// The student-facing display status for an assignment: the raw DB status,
// widened with the two derived states the DB never stores — "not_submitted"
// (no row yet) and "late" (a submitted hand-in past its due date).
export function displayStatus(
  submission: Pick<PrismaSubmission, "status" | "submittedAt"> | null,
  dueAt: Date | null,
): HomeworkSubmissionStatus {
  if (!submission) return "not_submitted";
  if (submission.status === "submitted" && isSubmissionLate(submission.submittedAt, dueAt)) {
    return "late";
  }
  return submission.status;
}

// Whether the student may still edit (add text / attach / remove files). Once
// a submission is final and resubmission is off, everything locks. `returned`
// (future) re-opens editing by design.
export function canEditSubmission(
  submission: Pick<PrismaSubmission, "status"> | null,
  allowResubmission: boolean,
): boolean {
  if (!submission) return true;
  switch (submission.status) {
    case "draft":
    case "returned":
      return true;
    case "submitted":
      return allowResubmission;
    case "graded":
      return false;
    default:
      return false;
  }
}

// Whether a final submit is allowed right now: editing must be open, and if the
// due date has passed the assignment must permit late submission.
export function canSubmit(
  submission: Pick<PrismaSubmission, "status"> | null,
  assignment: Pick<Assignment, "allowLateSubmission" | "allowResubmission" | "dueAt">,
  now: Date,
): boolean {
  if (!canEditSubmission(submission, assignment.allowResubmission)) return false;
  const pastDue = assignment.dueAt != null && assignment.dueAt.getTime() < now.getTime();
  if (pastDue && !assignment.allowLateSubmission) return false;
  return true;
}

async function toWireFile(f: PrismaSubmissionFile): Promise<HomeworkSubmissionFile> {
  return {
    id: f.id,
    fileName: f.fileName,
    fileType: f.fileType,
    fileSize: f.fileSize,
    viewUrl: await mintSubmissionSignedUrl(f.storagePath),
    uploadedAt: f.uploadedAt.toISOString(),
  };
}

export async function toWireSubmission(
  submission: PrismaSubmission & { files: PrismaSubmissionFile[] },
): Promise<HomeworkSubmission> {
  const files = await Promise.all(
    [...submission.files]
      .sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime())
      .map(toWireFile),
  );
  return {
    id: submission.id,
    status: submission.status as HomeworkSubmission["status"],
    textResponse: submission.textResponse,
    submittedAt: submission.submittedAt?.toISOString() ?? null,
    updatedAt: submission.updatedAt.toISOString(),
    files,
  };
}

export function toWireAssignmentSummary(
  a: Pick<Assignment, "id" | "title" | "dueAt">,
  submission: (Pick<PrismaSubmission, "status" | "submittedAt"> & { fileCount: number }) | null,
): HomeworkAssignmentSummary {
  const status = displayStatus(submission, a.dueAt);
  return {
    id: a.id,
    title: a.title,
    dueAt: a.dueAt?.toISOString() ?? null,
    status,
    late: status === "late",
    fileCount: submission?.fileCount ?? 0,
  };
}

export function toWireFeedback(f: PrismaFeedback): HomeworkFeedback {
  return {
    id: f.id,
    decision: f.decision,
    content: f.content,
    score: f.score,
    createdAt: f.createdAt.toISOString(),
  };
}

export function toWireAiReviewDraft(d: PrismaAiReviewDraft): HomeworkAiReviewDraft {
  return {
    id: d.id,
    instructions: d.instructions,
    // Persisted from an already-validated HomeworkAiReviewContent (ai-review.ts
    // is the only writer) — safe to trust the shape read back.
    content: d.content as HomeworkAiReviewContent,
    model: d.model,
    createdAt: d.createdAt.toISOString(),
    discardedAt: d.discardedAt?.toISOString() ?? null,
  };
}

export async function toWireAttempt(
  attempt: PrismaAttempt & {
    files: PrismaSubmissionFile[];
    feedback: PrismaFeedback | null;
    aiReviewDrafts?: PrismaAiReviewDraft[];
  },
): Promise<HomeworkAttempt> {
  const files = await Promise.all(
    [...attempt.files]
      .sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime())
      .map(toWireFile),
  );
  return {
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    textResponse: attempt.textResponse,
    submittedAt: attempt.submittedAt.toISOString(),
    files,
    feedback: attempt.feedback ? toWireFeedback(attempt.feedback) : null,
    aiReviewDrafts: (attempt.aiReviewDrafts ?? []).map(toWireAiReviewDraft),
  };
}

export async function toWireAssignmentDetail(
  a: Assignment,
  submission: (PrismaSubmission & { files: PrismaSubmissionFile[] }) | null,
  now: Date,
  latestFeedback: PrismaFeedback | null = null,
): Promise<HomeworkAssignmentDetail> {
  const status = displayStatus(submission, a.dueAt);
  return {
    id: a.id,
    bookingId: a.bookingId,
    title: a.title,
    instructions: a.instructions,
    dueAt: a.dueAt?.toISOString() ?? null,
    allowLateSubmission: a.allowLateSubmission,
    allowResubmission: a.allowResubmission,
    status,
    late: status === "late",
    pastDue: a.dueAt != null && a.dueAt.getTime() < now.getTime(),
    canSubmit: canSubmit(submission, a, now),
    canEdit: canEditSubmission(submission, a.allowResubmission),
    submission: submission ? await toWireSubmission(submission) : null,
    feedback: latestFeedback ? toWireFeedback(latestFeedback) : null,
  };
}

export function toWireTeacherAssignment(a: Assignment, submissionCount: number): TeacherAssignment {
  return {
    id: a.id,
    bookingId: a.bookingId,
    title: a.title,
    instructions: a.instructions,
    dueAt: a.dueAt?.toISOString() ?? null,
    allowLateSubmission: a.allowLateSubmission,
    allowResubmission: a.allowResubmission,
    createdAt: a.createdAt.toISOString(),
    submissionCount,
  };
}
