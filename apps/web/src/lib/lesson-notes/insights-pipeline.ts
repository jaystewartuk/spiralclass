import type { PrismaClient } from "@prisma/client";

import { logger } from "@/lib/logger";
import { inngest as defaultInngest } from "@/lib/inngest/client";
import {
  generateInsights as defaultGenerate,
  InsightsUnavailableError,
  writesEnglishInsights,
  type Insight,
  type InsightUtterance,
  type PronunciationWeakWord,
} from "./insights";

// Phase C orchestration. One run
// per `lesson.transcript.ready`: load the transcript + the booking's live-notes,
// ask Claude for categorised focus areas, and replace the booking's prior
// AI-suggested rows (idempotent re-gen). Side effects are injected so this is
// unit-testable without Claude or Inngest. The Inngest function wraps the Claude
// call in a retryable step.

const log = logger({ surface: "lesson-insights" });

type Db = Pick<
  PrismaClient,
  "lessonTranscript" | "booking" | "lessonInsight" | "lessonPronunciation"
>;

export type InsightsDeps = {
  prisma: Db;
  generate: typeof defaultGenerate;
  inngest: Pick<typeof defaultInngest, "send">;
};

export type InsightsOutcome =
  { code: "skipped"; reason: string } | { code: "generated"; count: number };

// Read the transcript JSON back into the utterance shape the prompt needs.
function toUtterances(value: unknown): InsightUtterance[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((u) => u as { speaker?: unknown; text?: unknown; startMs?: unknown })
    .filter(
      (u) => (u.speaker === "student" || u.speaker === "teacher") && typeof u.text === "string",
    )
    .map((u) => ({
      speaker: u.speaker as "student" | "teacher",
      text: String(u.text),
      atMs: typeof u.startMs === "number" ? u.startMs : 0,
    }));
}

// Read the stored pronunciation JSON ({ overall, weakWords }) back into the
// weak-word shape Phase C's prompt consumes. Tolerant of a missing/old row.
function toWeakWords(value: unknown): PronunciationWeakWord[] {
  const list = (value as { weakWords?: unknown })?.weakWords;
  if (!Array.isArray(list)) return [];
  return list
    .map((w) => w as { word?: unknown; accuracy?: unknown; atMs?: unknown; phonemes?: unknown })
    .filter((w) => typeof w.word === "string" && typeof w.accuracy === "number")
    .map((w) => ({
      word: String(w.word),
      accuracy: Number(w.accuracy),
      atMs: typeof w.atMs === "number" ? w.atMs : 0,
      ...(Array.isArray(w.phonemes)
        ? {
            phonemes: (w.phonemes as unknown[])
              .map((p) => p as { phoneme?: unknown; accuracy?: unknown })
              .filter((p) => typeof p.phoneme === "string" && typeof p.accuracy === "number")
              .map((p) => ({ phoneme: String(p.phoneme), accuracy: Number(p.accuracy) })),
          }
        : {}),
    }));
}

export async function generateAndStoreInsights(
  deps: Pick<InsightsDeps, "prisma" | "generate" | "inngest">,
  bookingId: string,
): Promise<InsightsOutcome> {
  const { prisma } = deps;

  const transcript = await prisma.lessonTranscript.findUnique({
    where: { bookingId },
    select: { utterances: true, language: true, teacherId: true },
  });
  if (!transcript) return { code: "skipped", reason: "no-transcript" };

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      teacherId: true,
      student: { select: { name: true } },
      teacher: { select: { locale: true, targetLanguage: true } },
      lessonNotes: {
        select: { audience: true, body: true, doneAt: true },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!booking) return { code: "skipped", reason: "no-booking" };

  const utterances = toUtterances(transcript.utterances);
  const teacherCues = booking.lessonNotes
    .filter((n) => n.audience === "teacher")
    .map((n) => ({ body: n.body, done: n.doneAt != null }));
  const studentNotes = booking.lessonNotes
    .filter((n) => n.audience === "student")
    .map((n) => ({ body: n.body }));

  // Nothing to analyse — neither speech nor teacher signal.
  if (utterances.length === 0 && teacherCues.length === 0 && studentNotes.length === 0) {
    return { code: "skipped", reason: "no-signal" };
  }

  // Phase D: audio-grounded pronunciation scores, if scoring ran (written by the
  // B pipeline before transcript.ready, so it's here when present). When present,
  // it flips Phase C's pronunciation rule from teacher-signal-only to score-based.
  const pronRow = await prisma.lessonPronunciation.findUnique({
    where: { bookingId },
    select: { scores: true },
  });
  const weakWords = toWeakWords(pronRow?.scores);

  let insights: Insight[];
  try {
    insights = await deps.generate({
      studentName: booking.student.name,
      // The language the STUDENT is graded in — her subject, not whatever tag
      // the ASR vendor was handed. `transcript.language` is the ASR tag, and
      // it is hardcoded to DEFAULT_LESSON_LANGUAGE ("es") upstream
      // (transcription/pipeline.ts), so reading it here told the model every
      // lesson on the platform was Spanish. That was invisible while the only
      // teacher taught Spanish, and wrong for anyone else.
      //
      // Deliberately `targetLanguage` and NOT `teachingLanguage`: the model is
      // judging the student's output against the rules of the language she is
      // LEARNING. That is the opposite of the intro-video analysis, which tags
      // ASR with `teachingLanguage` because the only voice there is the
      // teacher's own (see LessonIntroVideoAnalysis.language in schema.prisma).
      // The two coincide for a teacher of Spanish teaching in Spanish, which is
      // what masked both bugs.
      targetLanguage: booking.teacher.targetLanguage ?? transcript.language,
      utterances,
      teacherCues,
      studentNotes,
      en: writesEnglishInsights(booking.teacher.locale),
      pronunciation: weakWords.length ? { weakWords } : undefined,
    });
  } catch (err) {
    if (err instanceof InsightsUnavailableError) {
      // No Anthropic key — degrade gracefully, leave no rows.
      return { code: "skipped", reason: "ai-unavailable" };
    }
    throw err;
  }

  await replaceAiInsights(prisma, bookingId, booking.teacherId, insights);

  await deps.inngest.send({
    name: "lesson.insights.ready",
    data: { bookingId, teacherId: booking.teacherId, count: insights.length },
  });

  log.info("insights generated", { bookingId, count: insights.length });
  return { code: "generated", count: insights.length };
}

// Idempotent re-gen: drop the booking's prior AI-suggested, not-yet-confirmed
// rows, then insert the fresh set. Teacher-confirmed/edited rows (Phase E,
// confirmedAt set) are never touched. Delete-then-insert, not upsert, because
// the finding set itself changes between runs.
export async function replaceAiInsights(
  prisma: Pick<PrismaClient, "lessonInsight">,
  bookingId: string,
  teacherId: string,
  insights: Insight[],
): Promise<void> {
  await prisma.lessonInsight.deleteMany({
    where: { bookingId, source: "ai", confirmedAt: null },
  });
  if (insights.length === 0) return;
  await prisma.lessonInsight.createMany({
    data: insights.map((i) => ({
      bookingId,
      teacherId,
      category: i.category,
      summary: i.summary,
      evidence: i.evidence,
      suggestion: i.suggestion,
      atMs: i.atMs,
      source: "ai",
    })),
  });
}
