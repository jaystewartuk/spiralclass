"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireStudent } from "@/lib/auth";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { resolveStudentAssignment } from "@/lib/homework/access";
import { ensureSubmission, findSubmission } from "@/lib/homework/submission";
import { canEditSubmission, canSubmit } from "@/lib/homework/wire";
import { ApiAuthError } from "@/lib/api/auth";
import { enqueueHomeworkSubmitted } from "@/lib/notifications/enqueue";
import { emitNotificationQueued } from "@/lib/notifications/events";
import {
  ALLOWED_SUBMISSION_FILE_TYPES,
  MAX_SUBMISSION_FILE_BYTES,
  deleteSubmissionObject,
  headSubmissionObject,
  isSubmissionFilePath,
  presignSubmissionUpload,
} from "@/lib/storage/homework-file";
import { logger } from "@/lib/logger";

const log = logger({ surface: "web-homework-submission" });

// The STUDENT half of the homework workflow. The domain logic lives in
// lib/homework/* (access.ts, submission.ts, wire.ts), and these are now its
// only callers.
//
// Why this exists: the student class page was READ-ONLY by design — it listed
// an assignment and offered no way to act on it, so in practice homework could
// be set but never handed in, and a teacher's feedback could never be read:
// `homework_submitted` had never once fired in production. The
// public booking page now promises homework as part of what a student gets, and
// a public promise has to be reachable from the surface students actually use.
//
// Deliberately NOT a second set of business rules: every policy decision here
// (locked, past-due, empty, file type, size cap, path shape) calls the shared
// helper, so nothing can drift into disagreeing about whether a hand-in is
// allowed.

/**
 * Failure codes, not sentences. An HTTP route answers with a status plus a
 * reason string; a server action has no status line, so the reason IS
 * the return value and the client maps it through the shared catalog. That
 * keeps every message in all three locales — a returned literal here would be
 * English-and-Spanish only, which is what `app/actions/homework.ts` still does
 * for the teacher half and is worth not copying.
 */
export type HomeworkActionError =
  | "not-found"
  | "submission-locked"
  | "past-due"
  | "empty-submission"
  | "bad-type"
  | "bad-path"
  | "file-too-large"
  | "not-uploaded"
  | "upload-unavailable";

export type HomeworkActionResult<T = object> =
  ({ ok: true } & T) | { ok: false; error: HomeworkActionError };

const failed = (error: HomeworkActionError) => ({ ok: false as const, error });

/**
 * Resolve the caller's assignment, or a typed miss. Ownership is
 * `resolveStudentAssignment`'s job (the assignment's booking must belong to a
 * Student row sharing this caller's email) — never re-implemented here.
 */
async function forCaller(assignmentId: string) {
  const student = await requireStudent();
  try {
    return await resolveStudentAssignment(student, assignmentId);
  } catch (err) {
    if (err instanceof ApiAuthError) return null;
    throw err;
  }
}

function revalidate(bookingId: string, assignmentId: string) {
  revalidatePath(`/my-classes/${bookingId}/homework/${assignmentId}`);
  revalidatePath(`/my-classes/${bookingId}`);
}

// Trimmed before the empty check. Without the trim a hand-in of nothing but
// spaces counts as a typed answer and satisfies "text OR a file". That is a bug
// rather than a policy, and consistency with it would be worth less than a
// student not being able
// to submit a blank. The policy rules (locked / late / resubmission) stay
// byte-for-byte shared.
const textSchema = z
  .string()
  .max(50_000)
  .nullable()
  .transform((v) => {
    const trimmed = v?.trim() ?? "";
    return trimmed.length ? trimmed : null;
  });

/**
 * Save the typed answer without handing it in. Idempotent, never flips status,
 * so a draft save can't overwrite an answer that has already been handed in.
 */
export async function saveHomeworkDraftAction(
  assignmentId: string,
  textResponse: string | null,
): Promise<HomeworkActionResult> {
  const resolved = await forCaller(assignmentId);
  if (!resolved) return failed("not-found");
  const { assignment, studentId } = resolved;

  const existing = await findSubmission(assignment.id, studentId);
  if (!canEditSubmission(existing, assignment.allowResubmission)) {
    return failed("submission-locked");
  }

  const parsed = textSchema.safeParse(textResponse);
  if (!parsed.success) return failed("empty-submission");

  await ensureSubmission(assignment, studentId);
  await prisma.homeworkSubmission.update({
    where: { assignmentId_studentId: { assignmentId: assignment.id, studentId } },
    data: { textResponse: parsed.data },
  });

  revalidate(assignment.bookingId, assignment.id);
  return { ok: true };
}

/**
 * Step one of the two-step direct-to-R2 upload: issue a presigned PUT ticket.
 * The object key is server-chosen — the client never influences it, and step
 * two re-validates the path it hands back anyway.
 */
export async function presignHomeworkFileAction(
  assignmentId: string,
  contentType: string,
): Promise<HomeworkActionResult<{ uploadUrl: string; storagePath: string }>> {
  const resolved = await forCaller(assignmentId);
  if (!resolved) return failed("not-found");
  const { assignment, studentId } = resolved;

  const existing = await findSubmission(assignment.id, studentId);
  if (!canEditSubmission(existing, assignment.allowResubmission)) {
    return failed("submission-locked");
  }
  if (!ALLOWED_SUBMISSION_FILE_TYPES[contentType]) return failed("bad-type");

  const ticket = presignSubmissionUpload(
    assignment.teacherId,
    assignment.id,
    studentId,
    contentType,
    Date.now(),
  );
  if ("error" in ticket) return failed("upload-unavailable");

  return { ok: true, uploadUrl: ticket.uploadUrl, storagePath: ticket.storagePath };
}

const finalizeSchema = z.object({
  storagePath: z.string().min(1),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().min(1),
});

/**
 * Step two: the bytes are in R2, so record the row. The size is read back from
 * R2 with HEAD rather than trusted from the client, and the cap is enforced on
 * that real number.
 */
export async function attachHomeworkFileAction(
  assignmentId: string,
  input: { storagePath: string; fileName: string; mimeType: string },
): Promise<HomeworkActionResult<{ fileId: string }>> {
  const resolved = await forCaller(assignmentId);
  if (!resolved) return failed("not-found");
  const { assignment, studentId } = resolved;

  const existing = await findSubmission(assignment.id, studentId);
  if (!canEditSubmission(existing, assignment.allowResubmission)) {
    return failed("submission-locked");
  }

  const parsed = finalizeSchema.safeParse(input);
  if (!parsed.success) return failed("bad-path");
  const body = parsed.data;

  if (!isSubmissionFilePath(body.storagePath, assignment.teacherId, assignment.id, studentId)) {
    return failed("bad-path");
  }
  if (!ALLOWED_SUBMISSION_FILE_TYPES[body.mimeType]) return failed("bad-type");

  const size = await headSubmissionObject(body.storagePath);
  if (size == null) return failed("not-uploaded");
  if (size > MAX_SUBMISSION_FILE_BYTES) return failed("file-too-large");

  await ensureSubmission(assignment, studentId);
  const submission = await prisma.homeworkSubmission.findUniqueOrThrow({
    where: { assignmentId_studentId: { assignmentId: assignment.id, studentId } },
    select: { id: true },
  });

  const file = await prisma.homeworkSubmissionFile.create({
    data: {
      submissionId: submission.id,
      teacherId: assignment.teacherId,
      storagePath: body.storagePath,
      fileName: body.fileName,
      fileType: body.mimeType,
      fileSize: size,
    },
  });

  trackServerEvent({
    name: "homework_file_attached",
    distinctId: studentId,
    properties: {
      teacherId: assignment.teacherId,
      assignmentId: assignment.id,
      fileType: body.mimeType,
      sizeBytes: size,
      surface: "web",
    },
  });
  await flushAnalytics();

  revalidate(assignment.bookingId, assignment.id);
  return { ok: true, fileId: file.id };
}

/**
 * Detach one file while editing is still open. Scoped to THIS submission's
 * files, so a file id from someone else's submission is a miss, not a delete.
 */
export async function removeHomeworkFileAction(
  assignmentId: string,
  fileId: string,
): Promise<HomeworkActionResult> {
  const resolved = await forCaller(assignmentId);
  if (!resolved) return failed("not-found");
  const { assignment, studentId } = resolved;

  const submission = await findSubmission(assignment.id, studentId);
  if (!submission) return failed("not-found");
  if (!canEditSubmission(submission, assignment.allowResubmission)) {
    return failed("submission-locked");
  }

  const file = submission.files.find((f) => f.id === fileId);
  if (!file) return failed("not-found");

  await prisma.homeworkSubmissionFile.delete({ where: { id: file.id } });
  const ok = await deleteSubmissionObject(file.storagePath);
  if (!ok) log.warn("submission object delete failed", { storagePath: file.storagePath });

  revalidate(assignment.bookingId, assignment.id);
  return { ok: true };
}

/**
 * Hand it in: flip to `submitted`, snapshot the attempt, attribute this round's
 * files to it, and notify the teacher. Takes the latest text with the submit,
 * so a race with the draft save cannot drop the last keystrokes.
 */
export async function submitHomeworkAction(
  assignmentId: string,
  textResponse?: string | null,
): Promise<HomeworkActionResult> {
  const resolved = await forCaller(assignmentId);
  if (!resolved) return failed("not-found");
  const { assignment, studentId } = resolved;

  const existing = await findSubmission(assignment.id, studentId);
  const now = new Date();
  if (!canSubmit(existing, assignment, now)) {
    // Distinguish the two policy failures so the student sees the right reason:
    // already handed in, versus the late window having closed.
    return failed(
      assignment.dueAt && assignment.dueAt < now && !assignment.allowLateSubmission
        ? "past-due"
        : "submission-locked",
    );
  }

  const parsed = textSchema.safeParse(textResponse ?? null);
  const nextText =
    textResponse !== undefined && parsed.success ? parsed.data : (existing?.textResponse ?? null);

  const fileCount = await prisma.homeworkSubmissionFile.count({
    where: { submission: { assignmentId: assignment.id, studentId } },
  });
  if (!nextText && fileCount === 0) return failed("empty-submission");

  // One event, one transaction: the submission flip, its attempt snapshot, and
  // attributing this round's files all land together or not at all.
  const submitted = await prisma.$transaction(async (tx) => {
    const submission = await tx.homeworkSubmission.upsert({
      where: { assignmentId_studentId: { assignmentId: assignment.id, studentId } },
      create: {
        assignmentId: assignment.id,
        studentId,
        teacherId: assignment.teacherId,
        textResponse: nextText,
        status: "submitted",
        submittedAt: now,
      },
      update: {
        textResponse: nextText,
        status: "submitted",
        // Lateness is judged against the FIRST hand-in, so a resubmission never
        // moves the clock.
        submittedAt: existing?.submittedAt ?? now,
      },
      include: { files: true },
    });

    const attemptNumber =
      (await tx.homeworkAttempt.count({ where: { submissionId: submission.id } })) + 1;
    const attempt = await tx.homeworkAttempt.create({
      data: {
        submissionId: submission.id,
        attemptNumber,
        textResponse: nextText,
        submittedAt: now,
      },
    });
    await tx.homeworkSubmissionFile.updateMany({
      where: { submissionId: submission.id, attemptId: null },
      data: { attemptId: attempt.id },
    });

    return submission;
  });

  // Best-effort emit — the notification dispatcher covers a miss.
  try {
    const notificationId = await enqueueHomeworkSubmitted(prisma, {
      teacherId: assignment.teacherId,
      bookingId: assignment.bookingId,
      assignmentTitle: assignment.title,
    });
    await emitNotificationQueued({ notificationId, teacherId: assignment.teacherId });
  } catch (err) {
    log.warn("homework submit notify failed", { error: err });
  }

  trackServerEvent({
    name: "homework_submitted",
    distinctId: studentId,
    properties: {
      teacherId: assignment.teacherId,
      assignmentId: assignment.id,
      bookingId: assignment.bookingId,
      hasText: Boolean(nextText),
      fileCount,
      late:
        submitted.submittedAt != null &&
        assignment.dueAt != null &&
        submitted.submittedAt > assignment.dueAt,
      surface: "web",
    },
  });
  await flushAnalytics();

  revalidate(assignment.bookingId, assignment.id);
  return { ok: true };
}
