import type { PrismaClient } from "@prisma/client";
import type { IntroCoachFeedback } from "@spiralclass/shared";

import { logger } from "@/lib/logger";
import { teacherVideoPublicUrl } from "@/lib/storage/teacher-video";
import type { TranscriptionProvider } from "@/lib/transcription/provider";
import type { Utterance } from "@/lib/transcription/types";

// Layer 2 of the intro-video coach (D-73): turn a teacher's recorded/uploaded
// public intro video into a transcript, asynchronously, on the Inngest rail.
//
// The video lives in a PUBLIC R2 bucket, so — unlike lesson audio, which needs a
// short-lived presigned GET — the ASR vendor can pull the stable public URL
// directly (Deepgram extracts the audio track from the video container). This is
// a small, cheap, idempotent step: the whole thing re-runs safely on retry, keyed
// by the teacher's single analysis row.
//
// Everything the vendor/DB touches is injected so the core is a pure unit test:
// the Inngest handler wires the real provider + the real entitlement check.

const log = logger({ surface: "intro-video-transcribe" });

// Fallback ASR language when the teacher's row somehow carries none.
// Spanish-first, matching the lesson pipeline's DEFAULT_LESSON_LANGUAGE and
// `Teacher.teachingLanguage`'s own default.
const DEFAULT_LANGUAGE = "es";

// Two DIFFERENT language questions, answered from two different columns —
// conflating them is the exact bug `materials/prompt.ts` already documents
// having fixed once ("The two used to be conflated in this one field").
//
//   * What language is the teacher SPEAKING in the clip? → `teachingLanguage`,
//     which the schema documents as "the live-caption ASR source language" for
//     this teacher's own voice. This drives Deepgram.
//   * What language should we WRITE her feedback in? → `locale`, the
//     teacher-facing UI/email language.
//
// This pipeline previously used `targetLanguage` for BOTH. That column is the
// SUBJECT she teaches (D-72), which is neither question. The fault is LATENT:
// when a teacher's subject and her spoken language coincide (teaches Spanish,
// in Spanish — both "es") the old code was right by accident. It breaks the
// moment they diverge, which is the whole point of a language-first platform:
// a teacher OF English who teaches IN Spanish has targetLanguage "en", so her
// Spanish intro went to ASR tagged as English (garbage transcript) and the
// coach then wrote her feedback in English, against the house rule that
// teacher-facing copy is Spanish.
export function introVideoLanguages(teacher: {
  teachingLanguage?: string | null;
  locale?: string | null;
}): { asr: string; feedbackInEnglish: boolean } {
  return {
    asr: teacher.teachingLanguage?.trim() || DEFAULT_LANGUAGE,
    feedbackInEnglish: (teacher.locale?.trim() || "en").toLowerCase().startsWith("en"),
  };
}

export type IntroVideoReadyEvent = { teacherId: string; videoPath: string };

// The narrow slice of the Prisma client this pipeline uses — mirrors the
// lesson pipeline's `Db` typing so a test can pass a stub.
type Db = Pick<PrismaClient, "teacher" | "introVideoAnalysis">;

export type IntroVideoTranscribeDeps = {
  prisma: Db;
  provider: TranscriptionProvider;
  // Whether this teacher is entitled to the AI coach (Pro). Injected so the
  // pipeline stays free of the subscription service in tests; the handler passes
  // the real `loadEntitlements(...).canUseIntroVideoCoach`.
  canUseCoach: (teacherId: string) => Promise<boolean>;
  // Layer 3: turn the transcript into coach feedback. Injected + optional so the
  // transcript path stays testable in isolation; the handler passes
  // generateIntroCoachFeedback. A throw/failure here is best-effort — it never
  // fails the job or discards the transcript. Returns null when unparseable.
  generateFeedback?: (input: {
    transcript: string;
    durationSec: number | null;
    en: boolean;
  }) => Promise<IntroCoachFeedback | null>;
  // Terminal-outcome analytics. Injected (and optional) so the pipeline stays a
  // pure unit test; the handler passes the real PostHog emitters. Every exit
  // path reports — the skips included, because "how often is AI analysis
  // generated?" is unanswerable without knowing how often it was skipped, and
  // why (the Pro gate is by far the most likely reason).
  onOutcome?: (outcome: IntroVideoAnalysisOutcome) => void;
  onFailure?: (failure: { teacherId: string; reason: string; latencyMs: number }) => void;
  // Injected clock so latency assertions are deterministic in tests.
  now?: () => number;
};

export type IntroVideoAnalysisOutcome = {
  teacherId: string;
  outcome: "transcribed" | "no-video" | "stale" | "not-pro" | "no-public-url";
  coachGenerated: boolean;
  utterances: number | null;
  durationSec: number | null;
  latencyMs: number;
  provider: string | null;
};

export type IntroVideoTranscribeResult =
  | { ok: true; skipped: "no-video" | "stale" | "not-pro" }
  | { ok: true; utterances: number }
  | { ok: false; reason: "no-public-url" };

// Transcribe a teacher's current intro video into their IntroVideoAnalysis row.
// Skips (never throws) for the benign cases — no video, a stale event, or a
// non-Pro teacher — and only throws on a real transcription failure so Inngest
// retries. The analysis row's status tracks progress (transcribing → transcribed
// / failed) so a retry is idempotent and the state is observable.
export async function processIntroVideoReady(
  deps: IntroVideoTranscribeDeps,
  event: IntroVideoReadyEvent,
): Promise<IntroVideoTranscribeResult> {
  const { prisma, provider, canUseCoach } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();

  // Every exit path funnels through here, so a new early return can't silently
  // become a hole in the funnel.
  const report = (
    outcome: IntroVideoAnalysisOutcome["outcome"],
    extra: Partial<Omit<IntroVideoAnalysisOutcome, "teacherId" | "outcome" | "latencyMs">> = {},
  ) => {
    deps.onOutcome?.({
      teacherId: event.teacherId,
      outcome,
      coachGenerated: false,
      utterances: null,
      durationSec: null,
      provider: null,
      ...extra,
      latencyMs: now() - startedAt,
    });
  };

  const teacher = await prisma.teacher.findUnique({
    where: { id: event.teacherId },
    select: {
      id: true,
      introVideoPath: true,
      introVideoDurationMs: true,
      teachingLanguage: true,
      locale: true,
      updatedAt: true,
    },
  });
  if (!teacher || !teacher.introVideoPath) {
    report("no-video");
    return { ok: true, skipped: "no-video" };
  }
  // The event was queued for a specific object; if the teacher has since
  // re-recorded or cleared it, the current key won't match — drop the stale run.
  if (teacher.introVideoPath !== event.videoPath) {
    report("stale");
    return { ok: true, skipped: "stale" };
  }

  const durationSec =
    teacher.introVideoDurationMs != null ? Math.round(teacher.introVideoDurationMs / 1000) : null;

  if (!(await canUseCoach(teacher.id))) {
    // Non-Pro: recording/showing the video is free, but the AI analysis is a Pro
    // capability — don't spend vendor minutes. No row is written. Reported all
    // the same: this is the upgrade-intent signal for the whole feature.
    report("not-pro", { durationSec });
    return { ok: true, skipped: "not-pro" };
  }

  const publicUrl = teacherVideoPublicUrl(teacher.introVideoPath, teacher.updatedAt.getTime());
  if (!publicUrl) {
    // Storage bucket URL not configured — the video isn't actually reachable.
    log.warn("intro video public URL unavailable", { teacherId: teacher.id });
    report("no-public-url", { durationSec });
    return { ok: false, reason: "no-public-url" };
  }

  const { asr: language, feedbackInEnglish } = introVideoLanguages(teacher);

  await prisma.introVideoAnalysis.upsert({
    where: { teacherId: teacher.id },
    create: {
      teacherId: teacher.id,
      videoPath: teacher.introVideoPath,
      status: "transcribing",
      language,
    },
    update: {
      videoPath: teacher.introVideoPath,
      status: "transcribing",
      language,
      error: null,
    },
  });

  let utterances: Utterance[];
  try {
    const result = await provider.transcribe({ audioUrl: publicUrl, language });
    utterances = result.utterances;
  } catch (err) {
    const message = err instanceof Error ? err.message : "transcription-failed";
    await prisma.introVideoAnalysis.update({
      where: { teacherId: teacher.id },
      data: { status: "failed", error: message },
    });
    log.warn("intro video transcription failed", { teacherId: teacher.id, error: message });
    deps.onFailure?.({
      teacherId: teacher.id,
      reason: message,
      latencyMs: now() - startedAt,
    });
    throw err; // surface to Inngest so the step retries
  }

  await prisma.introVideoAnalysis.update({
    where: { teacherId: teacher.id },
    data: {
      status: "transcribed",
      provider: provider.vendor,
      transcript: utterances,
      error: null,
    },
  });

  // Layer 3: coach the teacher on the transcript. Best-effort — a missing
  // Anthropic key (IntroCoachUnavailableError) or any failure just leaves
  // coachFeedback null; the transcript is already stored and the job succeeds.
  let coachGenerated = false;
  if (deps.generateFeedback) {
    try {
      const transcript = utterances
        .map((u) => u.text)
        .join(" ")
        .trim();
      const feedback = await deps.generateFeedback({
        transcript,
        durationSec,
        // Her UI language, NOT the language she spoke in — see
        // introVideoLanguages above. A Spanish-speaking teacher of English gets
        // Spanish feedback about her (possibly English) intro.
        en: feedbackInEnglish,
      });
      if (feedback) {
        coachGenerated = true;
        await prisma.introVideoAnalysis.update({
          where: { teacherId: teacher.id },
          data: { coachFeedback: feedback },
        });
      }
    } catch (err) {
      log.warn("intro video coach feedback failed", {
        teacherId: teacher.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  report("transcribed", {
    coachGenerated,
    utterances: utterances.length,
    durationSec,
    provider: provider.vendor,
  });
  return { ok: true, utterances: utterances.length };
}
