import type { PrismaClient } from "@prisma/client";

import { logger } from "@/lib/logger";
import { inngest as defaultInngest } from "@/lib/inngest/client";
import { listParticipantMicTracks as defaultListMicTracks } from "@/lib/video/room";
import {
  lessonAudioKey,
  startParticipantAudioEgress as defaultStartEgress,
  stopEgress as defaultStopEgress,
} from "@/lib/video/recording";

// Lesson insights Phase A orchestration.
// The pure-ish core that turns the teacher's Record action into per-participant
// analysis audio: start one audio-only track egress per joined participant, land
// a LessonAudio row per egress, finalise on the LiveKit `egress_ended` webhook,
// and stop any danglers on `room_finished`. Side effects are injected so this is
// unit-testable without LiveKit, R2, or Inngest.
//
// Speaker mapping: the join grant mints a participant identity equal to the
// teacher/student user id (lib/video/provider.ts), so we map an egressed track
// back to a speaker by comparing its participant identity to the booking's
// teacherId/studentId. Unknown identities are skipped — there's no one to
// attribute the audio to.

const log = logger({ surface: "lesson-audio" });

type Db = Pick<PrismaClient, "lessonAudio">;

export type LessonAudioDeps = {
  listMicTracks: typeof defaultListMicTracks;
  startEgress: typeof defaultStartEgress;
  stopEgress: typeof defaultStopEgress;
  inngest: Pick<typeof defaultInngest, "send">;
};

const defaultDeps: LessonAudioDeps = {
  listMicTracks: defaultListMicTracks,
  startEgress: defaultStartEgress,
  stopEgress: defaultStopEgress,
  inngest: defaultInngest,
};

export type Speaker = "student" | "teacher";

type StartArgs = {
  bookingId: string;
  teacherId: string;
  studentId: string;
  room: string;
};

// Resolve a participant identity to a speaker role, or null if it's neither the
// booking's teacher nor its student.
export function speakerFor(
  identity: string,
  booking: { teacherId: string; studentId: string },
): Speaker | null {
  if (identity === booking.teacherId) return "teacher";
  if (identity === booking.studentId) return "student";
  return null;
}

// Start a per-participant audio-only egress for everyone currently in the room
// and write a `recording` LessonAudio row for each. Best-effort per participant:
// one failed egress doesn't abort the others (the A/V recording is unaffected
// regardless — this is a supplement). Returns the number of captures started.
//
// Idempotent per (bookingId, speaker): skips a speaker that already has an
// active `recording` row. This is what makes it safe to call from BOTH the
// manual Record button (startBookingRecording) and, since the recording/
// lesson-audio coupling fix, automatically on every `participant_joined`
// webhook — a reconnect or a second call to Record on the same booking never
// double-starts an egress for a speaker already being captured.
export async function startLessonAudioCaptures(
  db: Db,
  args: StartArgs,
  deps: LessonAudioDeps = defaultDeps,
): Promise<number> {
  const tracks = await deps.listMicTracks(args.room);
  let started = 0;

  for (const track of tracks) {
    const speaker = speakerFor(track.identity, args);
    if (!speaker) continue;

    const active = await db.lessonAudio.findFirst({
      where: { bookingId: args.bookingId, speaker, status: "recording" },
      select: { id: true },
    });
    if (active) continue;

    try {
      // The key is fixed before the egress starts (LiveKit writes to this exact
      // path); `Date.now()` keeps repeated Record sessions on the same booking
      // from colliding. Egress first: only persist a row once LiveKit accepted
      // it, so `egress_id` always points at a real (stoppable) egress.
      const storageKey = lessonAudioKey(args.bookingId, speaker, String(Date.now()));
      const { egressId } = await deps.startEgress(args.room, track.trackId, storageKey);

      await db.lessonAudio.create({
        data: {
          bookingId: args.bookingId,
          teacherId: args.teacherId,
          speaker,
          egressId,
          storageKey,
          status: "recording",
        },
      });
      started += 1;
    } catch (err) {
      log.error("start lesson-audio egress failed", err, {
        bookingId: args.bookingId,
        speaker,
      });
    }
  }

  return started;
}

export type FinalizeResult =
  | { code: "ignored"; reason: string }
  | { code: "finalized"; audioId: string; status: "ready" | "failed" };

type FinalizeArgs = {
  egressId: string;
  durationMs: number | null;
  // The egress ended in a failed/aborted state rather than completing.
  failed: boolean;
};

// Finalize a capture when its LiveKit `egress_ended` webhook lands: flip the row
// to `ready` (file is in R2) — or `failed` — and, on success, emit
// `lesson.audio.ready` for Phase B. Idempotent: the status-guarded updateMany
// means a replayed webhook updates zero rows and re-sends nothing, so the event
// fires exactly once per capture. Unknown egress ids (e.g. the A/V composite, or
// an egress we don't track) are ignored.
export async function finalizeLessonAudio(
  db: Db,
  args: FinalizeArgs,
  deps: LessonAudioDeps = defaultDeps,
): Promise<FinalizeResult> {
  const row = await db.lessonAudio.findUnique({
    where: { egressId: args.egressId },
    select: { id: true, bookingId: true, speaker: true, storageKey: true },
  });
  if (!row) return { code: "ignored", reason: "untracked-egress" };

  const nextStatus = args.failed ? "failed" : "ready";

  // Guarded flip: only a row still `recording` transitions, so concurrent or
  // replayed `egress_ended` deliveries can't double-apply (and can't re-emit).
  const updated = await db.lessonAudio.updateMany({
    where: { id: row.id, status: "recording" },
    data: {
      status: nextStatus,
      durationMs: args.durationMs ?? undefined,
      endedAt: new Date(),
    },
  });
  if (updated.count === 0) {
    return { code: "ignored", reason: "already-finalized" };
  }

  if (nextStatus === "ready") {
    await deps.inngest.send({
      name: "lesson.audio.ready",
      data: {
        bookingId: row.bookingId,
        audioId: row.id,
        speaker: row.speaker,
        storageKey: row.storageKey,
      },
    });
  }

  return { code: "finalized", audioId: row.id, status: nextStatus };
}

// Stop every still-recording capture for a booking. Used by stopCallRecording and
// by the `room_finished` webhook path (the call-ended-without-Stop case), so
// audio always finalises. Best-effort: a failed stopEgress is logged, not thrown
// — the row stays `recording` until its own `egress_ended` lands (or LiveKit
// finalises it on room close).
export async function stopLessonAudioCaptures(
  db: Db,
  bookingId: string,
  deps: LessonAudioDeps = defaultDeps,
): Promise<void> {
  const active = await db.lessonAudio.findMany({
    where: { bookingId, status: "recording" },
    select: { egressId: true },
  });
  for (const row of active) {
    try {
      await deps.stopEgress(row.egressId);
    } catch (err) {
      log.error("stop lesson-audio egress failed", err, { bookingId, egressId: row.egressId });
    }
  }
}
