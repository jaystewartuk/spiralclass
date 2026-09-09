import "server-only";

import type { Teacher } from "@prisma/client";
import type { HomeworkFeedback, HomeworkFeedbackDecision } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { ApiAuthError } from "@/lib/api/auth";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { enqueueHomeworkFeedbackAvailable } from "@/lib/notifications/enqueue";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { logger } from "@/lib/logger";
import { resolveTeacherAttempt } from "./access";
import { toWireFeedback } from "./wire";

const log = logger({ surface: "homework-feedback" });

export type CreateHomeworkFeedbackInput = {
  decision: HomeworkFeedbackDecision;
  content: string;
  score?: number | null;
};

// A decision maps onto the coarser HomeworkSubmission.status it re-opens or
// finalizes (see the HomeworkFeedbackDecision schema comment): approved
// finalizes as graded; the other two re-open the submission for editing
// regardless of the assignment's allowResubmission default.
function nextSubmissionStatus(decision: HomeworkFeedbackDecision): "graded" | "returned" {
  return decision === "approved" ? "graded" : "returned";
}

// Business logic behind the teacher dashboard review action, kept out of the
// route (same pattern as lib/materials/handlers.ts). Resolves + owns the attempt
// (throws ApiAuthError 404 on a miss, matching resolveTeacherAttempt),
// rejects a second review of the same attempt (409 "already-reviewed" — a
// review is a single, final action, not editable), creates the
// HomeworkFeedback row, flips the submission's status when this is its
// latest attempt, and best-effort notifies the student.
export async function createHomeworkFeedback(
  teacher: Teacher,
  attemptId: string,
  input: CreateHomeworkFeedbackInput,
  surface: "web" | "mobile",
): Promise<HomeworkFeedback> {
  const attempt = await resolveTeacherAttempt(teacher, attemptId);
  const { submission } = attempt;

  const existingFeedback = await prisma.homeworkFeedback.findUnique({
    where: { attemptId: attempt.id },
  });
  if (existingFeedback) throw new ApiAuthError(409, "already-reviewed");

  // Only the LATEST attempt's review flips the submission's current status —
  // feedback on a stale attempt (only reachable when allowResubmission let the
  // student resubmit before this one was reviewed) is still recorded, but must
  // not clobber a newer attempt's already-current state.
  const attemptCount = await prisma.homeworkAttempt.count({
    where: { submissionId: submission.id },
  });
  const isLatestAttempt = attempt.attemptNumber === attemptCount;

  const created = await prisma.$transaction(async (tx) => {
    const feedback = await tx.homeworkFeedback.create({
      data: {
        attemptId: attempt.id,
        teacherId: teacher.id,
        decision: input.decision,
        content: input.content,
        score: input.score ?? null,
      },
    });
    if (isLatestAttempt) {
      await tx.homeworkSubmission.update({
        where: { id: submission.id },
        data: { status: nextSubmissionStatus(input.decision) },
      });
    }
    return feedback;
  });

  try {
    const notificationId = await enqueueHomeworkFeedbackAvailable(prisma, {
      studentId: submission.studentId,
      teacherId: teacher.id,
      bookingId: submission.assignment.bookingId,
      assignmentTitle: submission.assignment.title,
      decision: input.decision,
    });
    await emitNotificationQueued({ notificationId, teacherId: teacher.id });
  } catch (err) {
    log.warn("homework feedback notify failed", { error: err });
  }

  trackServerEvent({
    name: "homework_feedback_created",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      assignmentId: submission.assignmentId,
      attemptId: attempt.id,
      decision: input.decision,
      hasScore: input.score != null,
      surface,
    },
  });

  return toWireFeedback(created);
}
