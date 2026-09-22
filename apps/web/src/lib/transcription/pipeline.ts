import type { PrismaClient } from "@prisma/client";

import { logger } from "@/lib/logger";
import { inngest as defaultInngest } from "@/lib/inngest/client";
import { DEFAULT_LESSON_LANGUAGE } from "./config";
import { mergeSpeakerSegment, normalizeTimeline } from "./merge";
import type { TranscriptionProvider } from "./provider";
import type { LessonAudioStore } from "./lesson-audio-store";
import type { Speaker, SpeakerUtterance } from "./types";
import { scoreAndStorePronunciation as defaultScorePronunciation } from "@/lib/pronunciation/score";

// Phase B pipeline core (lesson-insights Phase B, D-19). One run per
// `lesson.audio.ready` event: read the per-speaker audio from R2, transcribe it,
// merge it into the booking's transcript, mark the file transcribed, and —
// when every file is in — fire `lesson.transcript.ready` for Phase C. Then
// derive-then-discard: delete the raw audio unless the teacher opted to keep it.
//
// Phase D folds in here: the
// STUDENT file's pronunciation is scored after transcription but BEFORE the gate
// fires `lesson.transcript.ready` and BEFORE the discard, so the audio is still
// present and Phase C finds the scores. Best-effort — it never blocks the rest.
//
// All side effects are injected so this is unit-testable without R2, a vendor,
// or Inngest. The Inngest function wraps each external call in a retryable step.

const log = logger({ surface: "lesson-transcription" });

type Db = Pick<
  PrismaClient,
  "lessonAudio" | "lessonTranscript" | "teacher" | "lessonPronunciation"
>;

export type TranscriptionDeps = {
  prisma: Db;
  provider: TranscriptionProvider;
  store: LessonAudioStore;
  inngest: Pick<typeof defaultInngest, "send">;
  // Phase D scoring, injected for testability; defaults to the real scorer
  // (which is itself dormant unless pronunciation is enabled + configured).
  scorePronunciation?: typeof defaultScorePronunciation;
};

export type AudioReadyEvent = {
  bookingId: string;
  audioId: string;
  speaker: Speaker;
  storageKey: string;
};

export type ProcessOutcome =
  | { code: "skipped"; reason: string }
  | {
      code: "transcribed";
      audioId: string;
      utteranceCount: number;
      transcriptComplete: boolean;
      audioRetained: boolean;
    };

// Read the booking's stored utterances (JSON) back into typed form.
function readStoredUtterances(value: unknown): SpeakerUtterance[] {
  return Array.isArray(value) ? (value as SpeakerUtterance[]) : [];
}

export async function processLessonAudioReady(
  deps: TranscriptionDeps,
  event: AudioReadyEvent,
): Promise<ProcessOutcome> {
  const { prisma } = deps;

  // 1. Load the capture. Only a `ready` row is transcribable; anything else
  //    (already transcribed/deleted, or failed) is a no-op so replays are safe.
  const audio = await prisma.lessonAudio.findUnique({
    where: { id: event.audioId },
    select: {
      id: true,
      bookingId: true,
      teacherId: true,
      speaker: true,
      storageKey: true,
      status: true,
      startedAt: true,
    },
  });
  if (!audio) return { code: "skipped", reason: "audio-not-found" };
  if (audio.status !== "ready") return { code: "skipped", reason: `status-${audio.status}` };

  // 2. Mint a short-lived URL and transcribe (the vendor pulls the audio).
  const audioUrl = deps.store.presignedGetUrl(audio.storageKey);
  const result = await deps.provider.transcribe({
    audioUrl,
    language: DEFAULT_LESSON_LANGUAGE,
  });

  // 3. Merge this speaker's utterances into the booking's transcript (absolute
  //    timeline; rebased once complete — see merge.ts).
  const existing = await prisma.lessonTranscript.findUnique({
    where: { bookingId: audio.bookingId },
    select: { utterances: true, language: true },
  });
  const merged = mergeSpeakerSegment(readStoredUtterances(existing?.utterances), {
    speaker: audio.speaker as Speaker,
    egressStartMs: audio.startedAt.getTime(),
    result,
  });
  const language = existing?.language ?? DEFAULT_LESSON_LANGUAGE;

  await prisma.lessonTranscript.upsert({
    where: { bookingId: audio.bookingId },
    create: {
      bookingId: audio.bookingId,
      teacherId: audio.teacherId,
      language,
      utterances: merged as unknown as object,
      provider: result.provider,
    },
    update: { utterances: merged as unknown as object, provider: result.provider },
  });

  // 4. Mark this file transcribed (guarded so a replay doesn't re-run step 5/6).
  const marked = await prisma.lessonAudio.updateMany({
    where: { id: audio.id, status: "ready" },
    data: { status: "transcribed" },
  });
  if (marked.count === 0) return { code: "skipped", reason: "already-transcribed" };

  // 4b. Phase D: score the STUDENT file's pronunciation while the audio is still
  //     present — BEFORE the gate (step 5) fires lesson.transcript.ready and
  //     BEFORE the discard (step 6) — so Phase C finds the scores. Reuses the
  //     audio URL already minted for ASR and the just-produced transcript as the
  //     reference text. Best-effort: a scoring failure must never block the
  //     transcript event or the discard. Dormant unless pronunciation is enabled.
  if (audio.speaker === "student") {
    const referenceText = result.utterances
      .map((u) => u.text)
      .join(" ")
      .trim();
    if (referenceText) {
      try {
        const score = deps.scorePronunciation ?? defaultScorePronunciation;
        await score(prisma, {
          bookingId: audio.bookingId,
          teacherId: audio.teacherId,
          audioUrl,
          referenceText,
          language,
        });
      } catch (err) {
        log.error("pronunciation scoring failed", err, { audioId: audio.id });
      }
    }
  }

  // 5. All-files gate: when nothing is still pending (recording/ready), the
  //    booking's transcript is complete → rebase to a 0-based timeline and fire
  //    lesson.transcript.ready for Phase C.
  const pending = await prisma.lessonAudio.count({
    where: { bookingId: audio.bookingId, status: { in: ["recording", "ready"] } },
  });
  const complete = pending === 0;
  if (complete) {
    const normalized = normalizeTimeline(merged);
    await prisma.lessonTranscript.update({
      where: { bookingId: audio.bookingId },
      data: { utterances: normalized as unknown as object },
    });
    await deps.inngest.send({
      name: "lesson.transcript.ready",
      data: { bookingId: audio.bookingId },
    });
  }

  // 6. Derive-then-discard, keep-on-opt-in (D-19 item 6): delete the raw audio unless
  //    the teacher opted to retain it for playback.
  const teacher = await prisma.teacher.findUnique({
    where: { id: audio.teacherId },
    select: { lessonAudioRetentionOptIn: true },
  });
  const retain = teacher?.lessonAudioRetentionOptIn ?? false;
  if (!retain) {
    try {
      await deps.store.deleteObject(audio.storageKey);
      await prisma.lessonAudio.update({ where: { id: audio.id }, data: { status: "deleted" } });
    } catch (err) {
      // Leave the row 'transcribed' (audio still present) so a retry can discard
      // later; the transcript is already safe.
      log.error("discard audio failed", err, { audioId: audio.id });
    }
  }

  return {
    code: "transcribed",
    audioId: audio.id,
    utteranceCount: result.utterances.length,
    transcriptComplete: complete,
    audioRetained: retain,
  };
}
