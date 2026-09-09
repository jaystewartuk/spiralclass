import type { PrismaClient } from "@prisma/client";

import { gateProFeature } from "@/lib/subscriptions/enforce";
import { classCallRoom, getVideoProvider } from "@/lib/video/provider";
import {
  callRecordingKey,
  recordingEnabled,
  startRoomRecording,
  stopRoomRecording,
} from "@/lib/video/recording";
import { startLessonAudioCaptures, stopLessonAudioCaptures } from "@/lib/video/lesson-audio";
import { listRoomParticipantIdentities } from "@/lib/video/room";
import { lessonInsightsConsentOk } from "@/lib/lesson-notes/consent";
import { transcriptionEnabled } from "@/lib/transcription/config";
import { logger } from "@/lib/logger";

const log = logger({ surface: "call-recording" });

export type RecordingResult = { ok: true } | { ok: false; reason: string };

// Core for starting/stopping a booking's call recording, called by the web
// server action (app/actions/call-recording.ts). Keeping it here means the
// D-22 insights-consent gate and the stale-row self-heal live in exactly ONE
// place, which is what stopped the two from drifting. Callers own
// auth (requireOnboardedTeacher) and
// any cache revalidation; this owns the booking-scoped recording logic.

// Start recording a booking's call. Pro-gated, only when egress is configured.
// The A/V recording is unconditional; the per-speaker insights capture rides on
// the recorded per-student consent (D-22).
export async function startBookingRecording(
  prisma: PrismaClient,
  teacherId: string,
  bookingId: string,
): Promise<RecordingResult> {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, teacherId },
    select: { id: true, studentId: true },
  });
  if (!booking) return { ok: false, reason: "not-found" };

  // Lesson-insights consent (D-22): voice capture for the insights pipeline is
  // gated on a recorded, per-student consent — separate from (and stricter than)
  // the A/V recording. Loaded now so the capture step can decide; the A/V
  // recording itself is never gated on it.
  const insightsLink = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId, studentId: booking.studentId } },
    select: { isMinor: true, insightsConsentAt: true, guardianConsentAt: true },
  });

  const gate = await gateProFeature(teacherId, "lesson_notes");
  if (!gate.ok) return { ok: false, reason: "not-pro" };

  if (!recordingEnabled()) return { ok: false, reason: "not-configured" };

  // Self-heal a stale "recording" row before starting. An egress that ended any
  // way other than an explicit Stop — the teacher navigated away, the room
  // emptied, the websocket dropped — leaves the row marked "recording" with no
  // live egress, which would otherwise block every future Record on this booking.
  // The client only shows Record when it believes nothing is recording, so a
  // lingering row here is stale: stop its egress best-effort and complete it,
  // then start fresh. (The egress_ended webhook finalizes these rows too; this
  // keeps it working even if that webhook is delayed or unregistered.)
  const stale = await prisma.callRecording.findFirst({
    where: { bookingId: booking.id, status: "recording" },
    select: { id: true, egressId: true },
  });
  if (stale) {
    try {
      await stopRoomRecording(stale.egressId);
    } catch {
      log.warn("reconcile: stop stale egress failed", { egressId: stale.egressId });
    }
    await prisma.callRecording.update({
      where: { id: stale.id },
      data: { status: "completed", endedAt: new Date() },
    });
    log.info("reconciled stale recording row before start", { bookingId: booking.id });
  }

  const room = classCallRoom(booking.id);
  const storageKey = callRecordingKey(booking.id, String(Date.now()));
  try {
    const { egressId } = await startRoomRecording(room, storageKey);
    await prisma.callRecording.create({
      data: { bookingId: booking.id, teacherId, egressId, storageKey, status: "recording" },
    });
  } catch (err) {
    log.error("start recording failed", err, { bookingId: booking.id });
    return { ok: false, reason: "start-failed" };
  }

  // Per-participant analysis audio (Phase A, D-19) — a SUPPLEMENT to the A/V
  // recording, gated on the per-student insights consent (D-22). With no recorded
  // consent the A/V recording proceeds and only the insights capture is skipped.
  // Best-effort: a capture failure (or this skip) must not fail the A/V recording.
  const consentOk =
    insightsLink != null &&
    lessonInsightsConsentOk({
      isMinor: insightsLink.isMinor,
      insightsConsentAt: insightsLink.insightsConsentAt,
      guardianConsentAt: insightsLink.guardianConsentAt,
    });
  if (!consentOk) {
    log.info("lesson-audio captures skipped — no insights consent", { bookingId: booking.id });
  } else {
    try {
      await startLessonAudioCaptures(prisma, {
        bookingId: booking.id,
        teacherId,
        studentId: booking.studentId,
        room,
      });
    } catch (err) {
      log.error("start lesson-audio captures failed", err, { bookingId: booking.id });
    }
  }

  return { ok: true };
}

// Stop the active recording for a booking. Marks the row completed even if the
// egress stop call errors, so the UI never gets stuck showing "recording".
export async function stopBookingRecording(
  prisma: PrismaClient,
  teacherId: string,
  bookingId: string,
): Promise<RecordingResult> {
  const recording = await prisma.callRecording.findFirst({
    where: { bookingId, status: "recording", booking: { teacherId } },
    select: { id: true, egressId: true },
  });
  if (!recording) return { ok: false, reason: "not-recording" };

  try {
    await stopRoomRecording(recording.egressId);
  } catch (err) {
    log.error("stop recording failed", err, { egressId: recording.egressId });
  }
  await prisma.callRecording.update({
    where: { id: recording.id },
    data: { status: "completed", endedAt: new Date() },
  });

  // Stop the per-participant audio captures too. Their files finalise via the
  // LiveKit egress_ended webhook; if the teacher never taps Stop, the
  // room_finished webhook path stops them instead.
  try {
    await stopLessonAudioCaptures(prisma, bookingId);
  } catch (err) {
    log.error("stop lesson-audio captures failed", err, { bookingId });
  }

  return { ok: true };
}

// Auto-start per-participant lesson-audio capture on `participant_joined`,
// independent of the teacher's manual Record tap / CLASS_RECORDING_ENABLED.
//
// This fixes a real, previously-documented bug
// (docs/features/live-calls-video.md): recording.ts's startParticipantAudioEgress is commented as
// "deliberately independent of CLASS_RECORDING_ENABLED — only the provider's
// recordingConfigured() gates this," but the only call site
// (startBookingRecording, above) is itself gated behind `recordingEnabled()`
// — which includes the flag. With recording off, the insights pipeline could
// never start regardless of consent, contradicting the code's own stated
// intent. This entry point still never gates on CLASS_RECORDING_ENABLED — so
// consenting students get automatic capture whether or not the teacher ever
// taps the (separately-gated) visible Record button.
//
// It DOES gate on transcriptionEnabled() (D-114). Without this check that flag
// only stopped the audio at the ASR step: on-lesson-audio-ready.ts bails, but the
// per-participant audio has already been captured and uploaded to R2, where it
// then sits. So "transcription off" silently still meant "student voice
// recorded" — the opposite of what the flag is for, and of what its own module
// header claims ("nothing is captured or analyzed"). Audio that can never be
// transcribed has no product value and pure liability, so the gate belongs at
// the start of the pipeline rather than the middle. Deliberately
// transcriptionEnabled() rather than the bare flag: with no ASR vendor
// configured the pipeline is equally dead, and capture would again be storage
// with no purpose.
//
// Best-effort: called from the video-provider webhook, so any failure here
// must never surface as a webhook error. `startLessonAudioCaptures` is
// idempotent per (bookingId, speaker), so a duplicate `participant_joined`
// (e.g. a reconnect) is a safe no-op.
export async function maybeStartLessonAudioCapture(
  prisma: PrismaClient,
  bookingId: string,
): Promise<void> {
  if (!transcriptionEnabled()) return;

  const provider = getVideoProvider();
  if (!provider || !provider.recordingConfigured()) return;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, teacherId: true, studentId: true },
  });
  if (!booking) return;

  const insightsLink = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: booking.teacherId, studentId: booking.studentId } },
    select: { isMinor: true, insightsConsentAt: true, guardianConsentAt: true },
  });
  if (
    !insightsLink ||
    !lessonInsightsConsentOk({
      isMinor: insightsLink.isMinor,
      insightsConsentAt: insightsLink.insightsConsentAt,
      guardianConsentAt: insightsLink.guardianConsentAt,
    })
  ) {
    return;
  }

  try {
    await startLessonAudioCaptures(prisma, {
      bookingId: booking.id,
      teacherId: booking.teacherId,
      studentId: booking.studentId,
      room: classCallRoom(booking.id),
    });
  } catch (err) {
    log.error("maybeStartLessonAudioCapture failed", err, { bookingId: booking.id });
  }
}

// Auto-start a booking's recording on `participant_joined` when the teacher has
// turned on `autoRecordClasses` (D-132).
//
// Why this exists: with recording enabled (D-131), a class is recorded only if
// the teacher remembers to tap Record mid-lesson — and if she doesn't, there is
// no recording, no per-speaker audio, no transcript and no focus areas for the
// next class. The whole pipeline hung off one easily-forgotten tap. This makes
// the server do it for her, for teachers who ask for that.
//
// It changes WHO starts a recording, never what one may capture. Everything
// protective sits inside startBookingRecording and is reused verbatim rather
// than reimplemented: the Pro gate, `recordingEnabled()`, and — the one that
// matters — the D-22 per-student insights consent, which still decides
// separately whether any voice is captured for analysis. Both parties still see
// LiveKit's own recording indicator (components/video/class-call.tsx mirrors
// `room.isRecording`), so an auto-started recording is exactly as visible as a
// hand-started one.
//
// Two conditions beyond the flag, each load-bearing:
//
//   1. BOTH the teacher and the student must be in the room. A teacher who
//      opens the call early and waits is not in a class, and recording her
//      empty waiting room would capture her alone and burn egress CPU on the
//      2-OCPU box for nothing.
//   2. The booking must have NO CallRecording row at all — not merely no ACTIVE
//      one. This is what makes an explicit Stop stick: reconnects re-fire
//      `participant_joined` routinely, so guarding on "nothing is currently
//      recording" would silently restart a recording the teacher had just
//      chosen to end. Auto-start therefore happens at most once per booking,
//      and after that the control is hers.
//
// Best-effort, like its neighbours: called from the video-provider webhook, so
// no failure here may surface as a webhook error.
export async function maybeAutoStartRecording(
  prisma: PrismaClient,
  bookingId: string,
): Promise<void> {
  try {
    if (!recordingEnabled()) return;

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, teacherId: true, studentId: true },
    });
    if (!booking) return;

    const teacher = await prisma.teacher.findUnique({
      where: { id: booking.teacherId },
      select: { autoRecordClasses: true },
    });
    if (!teacher?.autoRecordClasses) return;

    // Condition 2 — checked before the room round-trip, since it's the cheaper
    // of the two and the common case on a reconnect.
    const existing = await prisma.callRecording.findFirst({
      where: { bookingId: booking.id },
      select: { id: true },
    });
    if (existing) return;

    // Condition 1.
    const room = classCallRoom(booking.id);
    const present = await listRoomParticipantIdentities(room);
    if (!present.includes(booking.teacherId) || !present.includes(booking.studentId)) return;

    const result = await startBookingRecording(prisma, booking.teacherId, booking.id);
    if (result.ok) {
      log.info("auto-started recording", { bookingId: booking.id });
    } else {
      log.info("auto-start declined", { bookingId: booking.id, reason: result.reason });
    }
  } catch (err) {
    log.error("maybeAutoStartRecording failed", err, { bookingId });
  }
}

// Finalize a booking's A/V recording when its room has fully closed
// (LiveKit's room_finished), independent of whether the teacher ever tapped
// Stop or got the chance to — a crash, a force-quit, or a dropped connection
// all leave the row on "recording" otherwise. Mirrors the stale-row self-heal
// in startBookingRecording above, but runs proactively from the webhook
// instead of waiting for the teacher's next Record attempt on this booking
// (which, for a booking whose class just ended, may never come).
export async function finalizeDanglingRecording(
  prisma: PrismaClient,
  bookingId: string,
): Promise<void> {
  const stale = await prisma.callRecording.findFirst({
    where: { bookingId, status: "recording" },
    select: { id: true, egressId: true },
  });
  if (!stale) return;

  try {
    await stopRoomRecording(stale.egressId);
  } catch (err) {
    log.warn("room_finished: stop dangling egress failed", {
      egressId: stale.egressId,
      err: String(err),
    });
  }
  await prisma.callRecording.update({
    where: { id: stale.id },
    data: { status: "completed", endedAt: new Date() },
  });
  log.info("finalized dangling recording on room_finished", { bookingId });
}
