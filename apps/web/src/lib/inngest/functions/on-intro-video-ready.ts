import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { introVideoCoachEnabled } from "@/lib/intro-video/config";
import { processIntroVideoReady, type IntroVideoReadyEvent } from "@/lib/intro-video/transcribe";
import { generateIntroCoachFeedback } from "@/lib/intro-video/coach";
import { getTranscriptionProvider } from "@/lib/transcription/provider";
import { loadEntitlements } from "@/lib/subscriptions/service";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";

const log = logger({ surface: "intro-video-ready" });

// Triggered when a teacher records/uploads their public intro video (D-73,
// Layer 2). Transcribes it into their IntroVideoAnalysis row so Layer 3 can
// coach on it. Dormant until `introVideoCoachEnabled()` (an explicit flag AND a
// configured ASR vendor) is true — until then this logs and returns, exactly
// like the lesson-audio handler under its own gate.
//
// The transcription work runs inside a `step.run` so the whole unit is retryable
// and idempotent on the analysis row's status guard. Pro gating and the vendor
// call are injected into the pure pipeline for testability.
type StepRunner = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };

// Exported for unit testing — drives the gate branches with a fake step runner.
export async function onIntroVideoReadyHandler({
  event,
  step,
}: {
  event: { data: IntroVideoReadyEvent };
  step: StepRunner;
}) {
  const data = event.data as IntroVideoReadyEvent;

  if (!introVideoCoachEnabled()) {
    log.info("intro-video.ready (coach disabled — log only)", { teacherId: data.teacherId });
    return { ok: true, enabled: false };
  }

  const provider = getTranscriptionProvider();
  if (!provider) {
    // Flag on but no vendor adapter — surface it, don't silently drop.
    log.warn("intro-video coach enabled but no transcription provider configured");
    return { ok: false, reason: "unconfigured" };
  }

  return await step.run("transcribe", async () => {
    try {
      return await processIntroVideoReady(
        {
          prisma,
          provider,
          canUseCoach: async (teacherId) =>
            (await loadEntitlements(teacherId)).canUseIntroVideoCoach,
          generateFeedback: (input) => generateIntroCoachFeedback(input),
          onOutcome: (outcome) =>
            trackServerEvent({
              name: "intro_video_analysis_completed",
              distinctId: outcome.teacherId,
              properties: outcome,
            }),
          onFailure: (failure) =>
            trackServerEvent({
              name: "intro_video_analysis_failed",
              distinctId: failure.teacherId,
              properties: failure,
            }),
        },
        data,
      );
    } finally {
      // In a `finally` because the vendor-failure path RE-THROWS (so Inngest
      // retries) — a flush after the call would never run for exactly the
      // outcome we most want measured. Inngest steps run outside a request
      // lifecycle, so nothing else drains the posthog-node queue.
      await flushAnalytics();
    }
  });
}

export const onIntroVideoReadyFn = inngest.createFunction(
  {
    id: "on-intro-video-ready",
    retries: 3,
    triggers: [{ event: "intro-video.ready" }],
  },
  onIntroVideoReadyHandler,
);
