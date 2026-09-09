import "server-only";

import type { Teacher } from "@prisma/client";
import {
  extractHomeworkExcerptText,
  parseMaterialDoc,
  type HomeworkAiReviewDraft,
} from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import { trackServerEvent } from "@/lib/analytics/posthog";
import type { AppLocale } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { mintSubmissionSignedUrl } from "@/lib/storage/homework-file";
import {
  DEFAULT_LESSON_LANGUAGE,
  homeworkAudioTranscriptionEnabled,
} from "@/lib/transcription/config";
import { getTranscriptionProvider } from "@/lib/transcription/provider";
import { resolveTeacherAttempt } from "./access";
import {
  HOMEWORK_AI_REVIEW_MONTHLY_CAP,
  HOMEWORK_AI_REVIEW_INSTRUCTIONS_MAX_CHARS,
} from "./config";

const log = logger({ surface: "homework-ai-review" });

// Text-extractable attachment types this reads inline (matches the "text
// extractable" half of docs/features/homework.md). Images
// and documents beyond plain text aren't extracted here yet — the model still
// reviews the submitted text/audio-transcript; a filename-only note is enough
// signal for the teacher that other files exist without misrepresenting what
// the AI actually looked at. `fileType` on HomeworkSubmissionFile stores the
// raw MIME type (see the finalize route), not the short extension.
const INLINE_TEXT_MIME_TYPES = new Set(["text/plain"]);
// Spoken-answer audio (slice 7) — same MIME set ALLOWED_SUBMISSION_FILE_TYPES
// accepts (homework-file.ts), transcribed via the same Deepgram adapter the
// lesson-recording pipeline uses (lib/transcription/deepgram.ts), gated
// separately (homeworkAudioTranscriptionEnabled() — see transcription/config.ts
// for why this is its own flag, not a reuse of the lesson-recording one).
const AUDIO_MIME_TYPES = new Set([
  "audio/mp4",
  "audio/mpeg",
  "audio/aac",
  "audio/x-m4a",
  "audio/m4a",
  "audio/webm",
  "audio/ogg",
]);
const ATTACHMENT_TEXT_MAX_CHARS = 4_000;

export type RequestHomeworkAiReviewResult =
  | { ok: true; draft: HomeworkAiReviewDraft }
  | { ok: false; code: "not-pro" | "cap" | "not-configured" | "error"; message: string };

// Business logic behind the teacher dashboard action, kept out of the route
// (same pattern as lib/materials/handlers.ts and lib/homework/feedback.ts). Every
// call creates a NEW draft row (regenerate = call again); nothing here mutates
// or requires an existing draft.
export async function requestHomeworkAiReview(
  teacher: Teacher,
  attemptId: string,
  input: { instructions?: string | null },
  locale: AppLocale,
): Promise<RequestHomeworkAiReviewResult> {
  const en = locale === "en";

  const gate = await gateProFeature(teacher.id, "homework_review");
  if (!gate.ok) return { ok: false, code: "not-pro", message: upgradeNudge(gate.limit, locale) };

  const attempt = await resolveTeacherAttempt(teacher, attemptId);
  const { submission } = attempt;
  const assignment = submission.assignment;

  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const usedThisMonth = await prisma.homeworkAiReviewDraft.count({
    where: { teacherId: teacher.id, createdAt: { gte: monthStart } },
  });
  if (usedThisMonth >= HOMEWORK_AI_REVIEW_MONTHLY_CAP) {
    return {
      ok: false,
      code: "cap",
      message: en
        ? `You've reached this month's AI review limit (${HOMEWORK_AI_REVIEW_MONTHLY_CAP}). You can still review and grade by hand.`
        : `Alcanzaste el límite de revisiones con IA de este mes (${HOMEWORK_AI_REVIEW_MONTHLY_CAP}). Aún puedes revisar y calificar a mano.`,
    };
  }

  // Pinned to the material at assignment-creation time in principle
  // (sourceMaterialRevisionId); the shipped auto-draft doesn't populate a
  // revision snapshot, so this reads the material's LIVE body — the doc's own
  // stated fallback for "no pinned revision" is exactly this.
  let materialExcerpt: string | null = null;
  if (assignment.sourceMaterialId) {
    const material = await prisma.libraryMaterial.findUnique({
      where: { id: assignment.sourceMaterialId },
      select: { body: true },
    });
    if (material?.body) {
      const doc = parseMaterialDoc(material.body);
      materialExcerpt = extractHomeworkExcerptText(doc) || material.body;
    }
  }

  const audioProvider = homeworkAudioTranscriptionEnabled() ? getTranscriptionProvider() : null;
  const attachmentTexts: { fileName: string; text: string }[] = [];
  for (const file of attempt.files) {
    const isText = INLINE_TEXT_MIME_TYPES.has(file.fileType);
    const isAudio = audioProvider != null && AUDIO_MIME_TYPES.has(file.fileType);
    if (!isText && !isAudio) continue;
    try {
      const url = await mintSubmissionSignedUrl(file.storagePath);
      if (!url) continue;
      if (isText) {
        const res = await fetch(url);
        if (!res.ok) continue;
        const text = (await res.text()).slice(0, ATTACHMENT_TEXT_MAX_CHARS);
        if (text.trim()) attachmentTexts.push({ fileName: file.fileName, text });
      } else if (audioProvider) {
        const transcript = await audioProvider.transcribe({
          audioUrl: url,
          language: DEFAULT_LESSON_LANGUAGE,
        });
        const text = transcript.utterances
          .map((u) => u.text)
          .join(" ")
          .slice(0, ATTACHMENT_TEXT_MAX_CHARS);
        if (text.trim()) attachmentTexts.push({ fileName: file.fileName, text });
      }
    } catch (err) {
      log.warn("attachment text fetch failed", { error: err, fileId: file.id });
    }
  }

  const teacherInstructions =
    input.instructions?.trim().slice(0, HOMEWORK_AI_REVIEW_INSTRUCTIONS_MAX_CHARS) || null;

  const { generateHomeworkAiReview } = await import("@/lib/ai/anthropic");
  const { anthropicModel } = await import("@/lib/env");
  const result = await generateHomeworkAiReview({
    assignmentTitle: assignment.title,
    assignmentInstructions: assignment.instructions,
    materialExcerpt,
    attemptText: attempt.textResponse,
    attachmentTexts,
    teacherInstructions,
    en,
  });

  if (!result.ok) {
    if (result.reason === "not-configured") {
      return {
        ok: false,
        code: "not-configured",
        message: en
          ? "AI review isn't available right now. You can still review and grade by hand."
          : "La revisión con IA no está disponible ahora. Aún puedes revisar y calificar a mano.",
      };
    }
    return {
      ok: false,
      code: "error",
      message: en
        ? "Couldn't generate an AI review. Please try again."
        : "No se pudo generar la revisión con IA. Inténtalo de nuevo.",
    };
  }

  const created = await prisma.homeworkAiReviewDraft.create({
    data: {
      attemptId: attempt.id,
      teacherId: teacher.id,
      instructions: teacherInstructions,
      content: result.content,
      model: anthropicModel(),
    },
  });

  trackServerEvent({
    name: "homework_ai_review_generated",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      assignmentId: submission.assignmentId,
      attemptId: attempt.id,
      hasMaterialExcerpt: Boolean(materialExcerpt),
      attachmentTextCount: attachmentTexts.length,
      hasTeacherInstructions: Boolean(teacherInstructions),
    },
  });

  return {
    ok: true,
    draft: {
      id: created.id,
      instructions: created.instructions,
      content: result.content,
      model: created.model,
      createdAt: created.createdAt.toISOString(),
      discardedAt: null,
    },
  };
}
