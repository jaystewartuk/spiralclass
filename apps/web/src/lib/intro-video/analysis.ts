import type { IntroCoachFeedback, IntroVideoAnalysisStatus } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { introVideoTranscriptText } from "@/lib/seo/jsonld";

// Load a teacher's AI coach feedback (D-73, Layer 3) for the booking-page editor
// — null until it's been generated (Pro teachers only, async after upload).
// Teacher-only; never surfaced on the public /b/<slug> page.
export async function loadIntroVideoCoach(teacherId: string): Promise<IntroCoachFeedback | null> {
  const analysis = await prisma.introVideoAnalysis.findUnique({
    where: { teacherId },
    select: { coachFeedback: true },
  });
  return (analysis?.coachFeedback as IntroCoachFeedback | null) ?? null;
}

export type IntroVideoAnalysisState = {
  // null when no analysis row exists yet — no video, coach disabled, or the
  // teacher isn't Pro. Lets the editor render a live "processing" state
  // instead of the teacher only finding out coachFeedback appeared on reload.
  status: IntroVideoAnalysisStatus | null;
  coach: IntroCoachFeedback | null;
  error: string | null;
  // Whether a non-empty transcript exists yet — drives whether Settings even
  // shows the "publish my transcript" opt-in (booking-page-ai-readability).
  // Never exposes the transcript TEXT itself here; that's read separately, on
  // the public page, only once the teacher has opted in.
  hasTranscript: boolean;
};

// Richer sibling of loadIntroVideoCoach: also surfaces the pipeline's current
// status + last failure reason, so a client can poll this and show
// processing/success/failure instead of silently waiting for coachFeedback.
export async function loadIntroVideoAnalysisState(
  teacherId: string,
): Promise<IntroVideoAnalysisState> {
  const analysis = await prisma.introVideoAnalysis.findUnique({
    where: { teacherId },
    select: { status: true, coachFeedback: true, error: true, transcript: true },
  });
  if (!analysis) return { status: null, coach: null, error: null, hasTranscript: false };
  return {
    status: analysis.status,
    coach: (analysis.coachFeedback as IntroCoachFeedback | null) ?? null,
    error: analysis.error,
    hasTranscript: introVideoTranscriptText(analysis.transcript) !== null,
  };
}
