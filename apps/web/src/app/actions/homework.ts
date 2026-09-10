"use server";

import { z } from "zod";
import { fromZonedTime } from "date-fns-tz";
import { HOMEWORK_FEEDBACK_MAX_SCORE } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { resolveTeacherAssignment } from "@/lib/homework/access";
import { createHomeworkFeedback } from "@/lib/homework/feedback";
import { requestHomeworkAiReview } from "@/lib/homework/ai-review";
import { HOMEWORK_AI_REVIEW_INSTRUCTIONS_MAX_CHARS } from "@/lib/homework/config";
import { ApiAuthError } from "@/lib/api/auth";
import { deleteSubmissionObject } from "@/lib/storage/homework-file";
import { logger } from "@/lib/logger";
import { revalidateAfterAction } from "@/lib/revalidate";

const log = logger({ surface: "web-homework" });

// The teacher's assignment actions, over the lib/homework/* domain logic
// (access.ts) — per docs/features/homework.md. Read/list is a
// plain Prisma query directly in the class-detail page (booking is already
// tenant-verified there); this file only covers the two mutations.

const bodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  instructions: z
    .string()
    .trim()
    .max(5000)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null)),
  dueAt: z.string().datetime().optional().nullable(),
});

export type CreateAssignmentState = { error?: string; ok?: boolean } | undefined;

export async function createAssignmentAction(
  _prev: CreateAssignmentState,
  formData: FormData,
): Promise<CreateAssignmentState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  const bookingId = String(formData.get("bookingId") ?? "");
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, teacherId: teacher.id },
    select: { id: true },
  });
  if (!booking) return { error: en ? "Class not found." : "Clase no encontrada." };

  // <input type="datetime-local"> gives a naive "wall clock" string with no
  // timezone — fromZonedTime interprets it as the TEACHER's local time
  // (matches blocked-dates.ts's identical pattern), not the server's.
  const dueAtRaw = String(formData.get("dueAt") ?? "").trim();
  const dueAtIso = dueAtRaw ? fromZonedTime(dueAtRaw, teacher.timezone).toISOString() : null;

  const parsed = bodySchema.safeParse({
    title: String(formData.get("title") ?? ""),
    instructions: formData.get("instructions") ? String(formData.get("instructions")) : null,
    dueAt: dueAtIso,
  });
  if (!parsed.success) {
    return { error: en ? "Enter a title." : "Escribe un título." };
  }

  const created = await prisma.assignment.create({
    data: {
      bookingId: booking.id,
      teacherId: teacher.id,
      title: parsed.data.title,
      instructions: parsed.data.instructions ?? null,
      dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : null,
      allowLateSubmission: formData.get("allowLateSubmission") === "true",
      allowResubmission: formData.get("allowResubmission") === "true",
    },
  });

  trackServerEvent({
    name: "homework_assignment_created",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      bookingId: booking.id,
      assignmentId: created.id,
      hasDueDate: created.dueAt != null,
      surface: "web",
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/classes/${booking.id}`);
  return { ok: true };
}

export async function deleteAssignmentAction(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const assignmentId = String(formData.get("assignmentId") ?? "");
  const bookingId = String(formData.get("bookingId") ?? "");
  if (!assignmentId) return;

  let assignment;
  try {
    assignment = await resolveTeacherAssignment(teacher, assignmentId);
  } catch (err) {
    if (err instanceof ApiAuthError) return; // not found / not owned — no-op
    throw err;
  }

  // Collect storage paths before the cascade wipes the rows (mirrors the
  // mobile DELETE route exactly).
  const files = await prisma.homeworkSubmissionFile.findMany({
    where: { submission: { assignmentId: assignment.id } },
    select: { storagePath: true },
  });

  await prisma.assignment.delete({ where: { id: assignment.id } });

  await Promise.all(
    files.map(async (f) => {
      const ok = await deleteSubmissionObject(f.storagePath);
      if (!ok) log.warn("submission object delete failed", { storagePath: f.storagePath });
    }),
  );

  trackServerEvent({
    name: "homework_assignment_deleted",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, assignmentId: assignment.id, surface: "web" },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/classes/${bookingId || assignment.bookingId}`);
}

// Teacher feedback on an attempt — the lib/homework/feedback.ts business
// logic, per docs/features/homework.md.

const feedbackBodySchema = z.object({
  decision: z.enum(["approved", "resubmission_requested", "rejected"]),
  content: z.string().trim().min(1).max(5000),
  score: z.number().int().min(0).max(HOMEWORK_FEEDBACK_MAX_SCORE).nullable(),
});

export type CreateFeedbackState = { error?: string; ok?: boolean } | undefined;

export async function createHomeworkFeedbackAction(
  _prev: CreateFeedbackState,
  formData: FormData,
): Promise<CreateFeedbackState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  const attemptId = String(formData.get("attemptId") ?? "");
  const bookingId = String(formData.get("bookingId") ?? "");
  const assignmentId = String(formData.get("assignmentId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const content = String(formData.get("content") ?? "");
  const scoreRaw = String(formData.get("score") ?? "").trim();

  const parsed = feedbackBodySchema.safeParse({
    decision,
    content,
    score: scoreRaw ? Number(scoreRaw) : null,
  });
  if (!parsed.success) {
    return { error: en ? "Enter feedback content." : "Escribe la retroalimentación." };
  }

  try {
    await createHomeworkFeedback(teacher, attemptId, parsed.data, "web");
  } catch (err) {
    if (err instanceof ApiAuthError) {
      return {
        error:
          err.reason === "already-reviewed"
            ? en
              ? "This submission was already reviewed."
              : "Esta entrega ya fue revisada."
            : en
              ? "Submission not found."
              : "Entrega no encontrada.",
      };
    }
    throw err;
  }
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/classes/${bookingId}/homework/${assignmentId}`);
  return { ok: true };
}

// Teacher AI review of an attempt — the lib/homework/ai-review.ts business
// logic, per docs/features/homework.md. Always
// creates a new draft row (regenerate = call again).

export type RequestAiReviewState = { error?: string; ok?: boolean } | undefined;

export async function requestAiReviewAction(
  _prev: RequestAiReviewState,
  formData: FormData,
): Promise<RequestAiReviewState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();

  const attemptId = String(formData.get("attemptId") ?? "");
  const bookingId = String(formData.get("bookingId") ?? "");
  const assignmentId = String(formData.get("assignmentId") ?? "");
  const instructionsRaw = String(formData.get("instructions") ?? "").trim();
  const instructions = instructionsRaw
    ? instructionsRaw.slice(0, HOMEWORK_AI_REVIEW_INSTRUCTIONS_MAX_CHARS)
    : null;

  let result;
  try {
    result = await requestHomeworkAiReview(teacher, attemptId, { instructions }, locale);
  } catch (err) {
    if (err instanceof ApiAuthError) {
      return { error: locale === "en" ? "Submission not found." : "Entrega no encontrada." };
    }
    throw err;
  }
  if (!result.ok) return { error: result.message };
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/classes/${bookingId}/homework/${assignmentId}`);
  return { ok: true };
}
