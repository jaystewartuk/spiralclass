import type { PrismaClient } from "@prisma/client";
import type { NormalizedVideoEvent } from "@spiralclass/shared";

import { bookingIdFromCallRoom } from "@/lib/video/provider";
import { finalizeLessonAudio, stopLessonAudioCaptures } from "@/lib/video/lesson-audio";
import {
  finalizeDanglingRecording,
  maybeAutoStartRecording,
  maybeStartLessonAudioCapture,
} from "@/lib/video/call-recording";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { logger } from "@/lib/logger";

const log = logger({ surface: "video-webhook-events" });

// Best-effort analytics: a PostHog failure must never affect webhook
// processing (mirrors how call-recording.ts treats its own side effects).
// Loads the booking's teacherId — every call-lifecycle event needs it as the
// PostHog `teacher` group key, and there's no cheaper source of truth than
// the booking row itself.
async function trackCallEvent(
  prisma: PrismaClient,
  bookingId: string,
  build: (teacherId: string) => Parameters<typeof trackServerEvent>[0],
): Promise<void> {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { teacherId: true },
    });
    if (!booking) return;
    trackServerEvent(build(booking.teacherId));
  } catch (err) {
    log.warn("call analytics event failed", { bookingId, err: String(err) });
  }
}

// Provider-agnostic side effects for a normalized video-provider webhook event
// (docs/features/live-calls-video.md). Split out of
// app/api/livekit/webhook/route.ts so the route stays a thin
// verify+dedup+dispatch shell — this is the part that's reusable, unchanged,
// for any future provider.

export type WebhookOutcome = { code: string; [key: string]: unknown };

export async function handleNormalizedEvent(
  prisma: PrismaClient,
  event: NormalizedVideoEvent,
): Promise<WebhookOutcome> {
  if (event.kind === "recording_ended") {
    // A room-composite recording (CallRecording) and a per-participant
    // analysis recording (LessonAudio) both complete via this event kind,
    // each keyed by the provider's recording id. Finalize the call-recording
    // row if this is one — otherwise it's a lesson-audio recording. An
    // egress/recording that ends WITHOUT an explicit Stop (empty room, the
    // teacher navigated away, a network drop) would otherwise leave the row
    // stuck on "recording" and block the next Record on that booking.
    // Matched on egressId ALONE — deliberately NOT `egressId + status:
    // "recording"`, which is what this used to do and which made this branch
    // dead code for every class long enough to matter.
    //
    // `room_finished` fires the moment the room closes; `egress_ended` only
    // arrives once the file has finished UPLOADING. For a real 51-minute class
    // on 2026-08-27 that gap was 3m2s (846 MB), so finalizeDanglingRecording's
    // room_finished sweep had always already moved the row off "recording" by
    // the time this event landed. The row was therefore finalized by the
    // sweep's optimistic guess, the egress's own verdict and duration were
    // discarded, and `call_recording_finished` never fired.
    //
    // egressId is @unique, so findUnique is both correct and cheaper. A
    // lesson-audio egress still falls through to finalizeLessonAudio below,
    // because its id is not in this table at all.
    const rec = await prisma.callRecording.findUnique({
      where: { egressId: event.providerRecordingId },
      select: { id: true, bookingId: true, teacherId: true, endedAt: true },
    });
    if (rec) {
      await prisma.callRecording.update({
        where: { id: rec.id },
        data: {
          // The egress's own verdict is authoritative and CORRECTS the sweep,
          // which can only ever assume success — it has nothing better to go on.
          status: event.failed ? "failed" : "completed",
          // Keep the sweep's timestamp when it already set one: it fired at
          // room close, which is nearer the true end of the recording than
          // this upload-completion moment.
          endedAt: rec.endedAt ?? new Date(),
        },
      });
      // Low-priority PostHog forward (the call-analytics review
      // the call-analytics review) — this DB write already existed; PostHog never saw it.
      trackServerEvent({
        name: "call_recording_finished",
        distinctId: rec.teacherId,
        properties: { teacherId: rec.teacherId, bookingId: rec.bookingId, failed: event.failed },
      });
      return { code: "call-recording-finalized", failed: event.failed };
    }

    return await finalizeLessonAudio(prisma, {
      egressId: event.providerRecordingId,
      durationMs: event.durationMs,
      failed: event.failed,
    });
  }

  if (event.kind === "room_finished") {
    const bookingId = bookingIdFromCallRoom(event.room);
    if (!bookingId) return { code: "ignored", reason: "not-a-class-room" };
    // Stop any captures still recording so they finalise even without a Stop
    // tap.
    await stopLessonAudioCaptures(prisma, bookingId);
    // Same for the room-composite A/V recording — the room is confirmed fully
    // closed at this point, so any row still marked "recording" is definitely
    // orphaned (see finalizeDanglingRecording's own comment for why).
    await finalizeDanglingRecording(prisma, bookingId);
    // Low-priority PostHog forward, same rationale as recording_ended above.
    await trackCallEvent(prisma, bookingId, (teacherId) => ({
      name: "call_room_finished",
      distinctId: teacherId,
      properties: { teacherId, bookingId },
    }));
    return { code: "room-finished-swept", bookingId };
  }

  if (event.kind === "room_started") {
    const bookingId = bookingIdFromCallRoom(event.room);
    if (!bookingId) return { code: "ignored", reason: "not-a-class-room" };
    await trackCallEvent(prisma, bookingId, (teacherId) => ({
      name: "call_started",
      distinctId: teacherId,
      properties: { teacherId, bookingId },
    }));
    return { code: "call-started-tracked", bookingId };
  }

  if (event.kind === "participant_joined") {
    const bookingId = bookingIdFromCallRoom(event.room);
    if (!bookingId) return { code: "ignored", reason: "not-a-class-room" };
    // Auto-start lesson-audio capture for consenting students — decoupled
    // from CLASS_RECORDING_ENABLED, see call-recording.ts's
    // maybeStartLessonAudioCapture doc comment for why this lives here
    // rather than behind the manual Record button.
    await maybeStartLessonAudioCapture(prisma, bookingId);
    // Auto-start the A/V recording when the teacher opted into it and both
    // parties are now in the room (D-132). Deliberately AFTER the capture
    // above and independent of it: the two answer different questions (may we
    // analyse this student's voice, versus does this teacher want her classes
    // recorded) and neither implies the other.
    await maybeAutoStartRecording(prisma, bookingId);
    // The presence-timeline counterpart to call_participant_left below — this
    // webhook kind and the booking lookup already existed; PostHog just never
    // saw it (the call-analytics review).
    await trackCallEvent(prisma, bookingId, (teacherId) => ({
      name: "call_participant_joined",
      distinctId: teacherId,
      properties: {
        teacherId,
        bookingId,
        role: event.identity === teacherId ? "teacher" : event.identity ? "student" : "unknown",
      },
    }));
    return { code: "lesson-audio-capture-checked", bookingId };
  }

  if (event.kind === "participant_left") {
    const bookingId = bookingIdFromCallRoom(event.room);
    if (!bookingId) return { code: "ignored", reason: "not-a-class-room" };
    await trackCallEvent(prisma, bookingId, (teacherId) => ({
      name: "call_participant_left",
      distinctId: teacherId,
      properties: {
        teacherId,
        bookingId,
        role: event.identity === teacherId ? "teacher" : event.identity ? "student" : "unknown",
      },
    }));
    return { code: "call-participant-left-tracked", bookingId };
  }

  if (event.kind === "egress_started") {
    const bookingId = bookingIdFromCallRoom(event.room ?? "");
    if (!bookingId) return { code: "ignored", reason: "not-a-class-room" };
    await trackCallEvent(prisma, bookingId, (teacherId) => ({
      name: "call_recording_started",
      distinctId: teacherId,
      properties: { teacherId, bookingId },
    }));
    return { code: "call-recording-started-tracked", bookingId };
  }

  return { code: "ignored", reason: "unhandled-event" };
}
