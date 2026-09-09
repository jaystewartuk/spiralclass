import { prisma } from "@/lib/prisma";
import { trackServerEvent } from "@/lib/analytics/posthog";

// Server-side intro-video analytics (D-73), owned here so no caller can drift
// on property names or shapes — the funnel is only meaningful if every
// `surface` stamps otherwise-identical events.
//
// The teacher-side funnel is deliberately split across two tiers:
//   * CLIENT events (recorder opened → recording started → completed → upload
//     started/failed) — the server never hears about an attempt that died at the
//     camera-permission prompt or on the R2 PUT, so those must be captured where
//     they happen.
//   * SERVER events (here) — the outcomes that are authoritative and must
//     survive an ad-blocker: the video was stored, or removed.

// Whether AI coach feedback existed for the video being REPLACED, and how old
// it was. This pair is the measurement of "do teachers act on the AI
// suggestions?": a replacement saved a few minutes after feedback landed is a
// teacher acting on it; one saved a month later, or with no feedback at all,
// is not. Read BEFORE the new video is stored — the pipeline overwrites the row.
export type PriorCoachSignal = {
  hadCoachFeedback: boolean;
  coachFeedbackAgeMs: number | null;
};

export async function readPriorCoachSignal(
  teacherId: string,
  now: number = Date.now(),
): Promise<PriorCoachSignal> {
  const prior = await prisma.introVideoAnalysis
    .findUnique({
      where: { teacherId },
      select: { coachFeedback: true, updatedAt: true },
    })
    .catch(() => null);
  if (!prior?.coachFeedback) return { hadCoachFeedback: false, coachFeedbackAgeMs: null };
  return {
    hadCoachFeedback: true,
    coachFeedbackAgeMs: Math.max(0, now - prior.updatedAt.getTime()),
  };
}

// Emit `teacher_intro_video_set`. `prior` is only meaningful on a replacement —
// on a teacher's FIRST video there is nothing to have acted on, so both
// coach-related properties are null rather than a misleading `false`.
export function trackIntroVideoSet(input: {
  teacherId: string;
  surface: "web" | "mobile";
  source: "record" | "upload";
  durationMs: number | null;
  sizeBytes: number | null;
  isReplacement: boolean;
  prior: PriorCoachSignal;
}): void {
  trackServerEvent({
    name: "teacher_intro_video_set",
    distinctId: input.teacherId,
    properties: {
      teacherId: input.teacherId,
      durationMs: input.durationMs,
      surface: input.surface,
      source: input.source,
      sizeBytes: input.sizeBytes,
      isReplacement: input.isReplacement,
      afterCoachFeedback: input.isReplacement ? input.prior.hadCoachFeedback : null,
      coachFeedbackAgeMs: input.isReplacement ? input.prior.coachFeedbackAgeMs : null,
    },
  });
}

export function trackIntroVideoRemoved(input: {
  teacherId: string;
  surface: "web" | "mobile";
  hadCoachFeedback: boolean;
}): void {
  trackServerEvent({
    name: "teacher_intro_video_removed",
    distinctId: input.teacherId,
    properties: {
      teacherId: input.teacherId,
      surface: input.surface,
      hadCoachFeedback: input.hadCoachFeedback,
    },
  });
}
