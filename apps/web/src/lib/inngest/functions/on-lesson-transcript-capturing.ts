import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { finalizeBrowserTranscript } from "@/lib/transcription/browser-transcript";

// The completion fallback for a browser-written lesson transcript (D-189).
//
// The transcript is normally finalised by the LiveKit `room_finished` webhook
// (lib/video/webhook-events.ts). That webhook has gone missing before — #108,
// when the media host changed and nobody re-pointed it — and without it a
// transcript would sit "live" for ever and Phase C would never run. So the
// first kept line of a class fires `lesson.transcript.capturing`, and this
// waits until the class is surely over, then finalises. Finalising is
// idempotent under the row's provider guard, so whichever of the two runs
// second is a no-op.
//
// "Surely over" is the booking's scheduled end plus a grace period for a class
// that runs long, and never sooner than a minimum wait from now, for a class
// that started after its scheduled end.
export const CAPTURE_GRACE_MS = 30 * 60_000;
export const CAPTURE_MIN_WAIT_MS = 10 * 60_000;

type StepRunner = {
  run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T>;
  sleepUntil: (id: string, until: Date) => Promise<void>;
};
type CapturingEvent = { data: { bookingId: string } };

export function finalizeAt(scheduledEnd: Date | null, now: number): Date {
  const afterClass = (scheduledEnd?.getTime() ?? 0) + CAPTURE_GRACE_MS;
  return new Date(Math.max(afterClass, now + CAPTURE_MIN_WAIT_MS));
}

// Exported for unit testing — drives the handler with a fake step runner.
export async function onLessonTranscriptCapturingHandler({
  event,
  step,
}: {
  event: CapturingEvent;
  step: StepRunner;
}) {
  const { bookingId } = event.data;
  const scheduledEnd = await step.run("load-scheduled-end", async () => {
    // tenancy-exempt: a background job keyed by the booking the browsers named;
    // the finalise step scopes its writes by the transcript row's own teacher_id.
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { scheduledEnd: true },
    });
    return booking?.scheduledEnd?.toISOString() ?? null;
  });
  await step.sleepUntil(
    "class-over",
    finalizeAt(scheduledEnd ? new Date(scheduledEnd) : null, Date.now()),
  );
  return await step.run("finalize-transcript", () =>
    finalizeBrowserTranscript(prisma, inngest, bookingId),
  );
}

export const onLessonTranscriptCapturingFn = inngest.createFunction(
  {
    id: "on-lesson-transcript-capturing",
    retries: 3,
    triggers: [{ event: "lesson.transcript.capturing" }],
  },
  onLessonTranscriptCapturingHandler,
);
