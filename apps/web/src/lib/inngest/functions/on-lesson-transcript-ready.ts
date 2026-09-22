import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { generateInsights } from "@/lib/lesson-notes/insights";
import { generateAndStoreInsights } from "@/lib/lesson-notes/insights-pipeline";

// Lesson insights Phase C (the Phase C design, D-19).
// Triggered once per booking when its transcript is ready (Phase B). Turns the
// transcript + the teacher's live-notes into categorised, evidence-anchored
// focus areas and stores them as read-only AI-suggested rows.
//
// Inherits Phase B's gate implicitly: the event only fires when the
// transcription pipeline is enabled. Degrades gracefully without ANTHROPIC_API_KEY
// (the pipeline skips, leaving no rows). The Claude call is a retryable step.
type StepRunner = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };
type TranscriptReadyEvent = { data: { bookingId: string } };

// Exported for unit testing — drives the handler with a fake step runner.
export async function onLessonTranscriptReadyHandler({
  event,
  step,
}: {
  event: TranscriptReadyEvent;
  step: StepRunner;
}) {
  const { bookingId } = event.data;
  return await step.run("generate-insights", () =>
    generateAndStoreInsights({ prisma, generate: generateInsights, inngest }, bookingId),
  );
}

export const onLessonTranscriptReadyFn = inngest.createFunction(
  {
    id: "on-lesson-transcript-ready",
    retries: 3,
    triggers: [{ event: "lesson.transcript.ready" }],
  },
  onLessonTranscriptReadyHandler,
);
