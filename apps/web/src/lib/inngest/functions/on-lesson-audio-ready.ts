import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { transcriptionEnabled } from "@/lib/transcription/config";
import { getTranscriptionProvider } from "@/lib/transcription/provider";
import { getLessonAudioStore } from "@/lib/transcription/lesson-audio-store";
import { processLessonAudioReady, type AudioReadyEvent } from "@/lib/transcription/pipeline";

const log = logger({ surface: "lesson-audio-ready" });

// Triggered once per per-speaker audio capture (lesson-insights Phase A fires
// `lesson.audio.ready`). Phase B turns that audio into a transcript.
//
// ⛔ Gated. The whole transcription path is BLOCKED on the privacy/consent legal
// sign-off (D-19 item 6) — until `transcriptionEnabled()` (an explicit flag AND a
// configured vendor) is true, this stays in Phase A behaviour: structured-log
// only, no audio sent anywhere, no transcript stored. Flipping the flag (after
// sign-off) switches it to the real pipeline with no code change.
//
// Each external call (R2 read, ASR, discard) runs inside the pipeline; the step
// wrapper makes the whole unit retryable and the work idempotent on the audio
// row's status guard.
type StepRunner = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };

// Exported for unit testing — drives the gate branches with a fake step runner.
export async function onLessonAudioReadyHandler({
  event,
  step,
}: {
  event: { data: AudioReadyEvent };
  step: StepRunner;
}) {
  const data = event.data as AudioReadyEvent;

  if (!transcriptionEnabled()) {
    // Phase A / disabled: prove the event fires end-to-end, do nothing else.
    log.info("lesson.audio.ready (transcription disabled — log only)", {
      bookingId: data.bookingId,
      audioId: data.audioId,
      speaker: data.speaker,
    });
    return { ok: true, enabled: false };
  }

  const provider = getTranscriptionProvider();
  const store = getLessonAudioStore();
  if (!provider || !store) {
    // Flag on but a dependency is unconfigured — surface it, don't silently drop.
    log.warn("transcription enabled but provider/store unconfigured", {
      hasProvider: Boolean(provider),
      hasStore: Boolean(store),
    });
    return { ok: false, reason: "unconfigured" };
  }

  return await step.run("transcribe", () =>
    processLessonAudioReady({ prisma, provider, store, inngest }, data),
  );
}

export const onLessonAudioReadyFn = inngest.createFunction(
  {
    id: "on-lesson-audio-ready",
    retries: 3,
    triggers: [{ event: "lesson.audio.ready" }],
  },
  onLessonAudioReadyHandler,
);
