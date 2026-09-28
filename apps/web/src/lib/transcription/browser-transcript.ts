import type { Booking, PrismaClient } from "@prisma/client";

import type { inngest as defaultInngest } from "@/lib/inngest/client";
import { lessonInsightsConsentOk } from "@/lib/lesson-notes/consent";
import { logger } from "@/lib/logger";
import { DEFAULT_LESSON_LANGUAGE, browserTranscriptEnabled } from "./config";
import { normalizeTimeline } from "./merge";
import type { CallRole } from "@spiralclass/shared";
import type { SpeakerUtterance } from "./types";

// The lesson transcript, written by the participants' browsers (D-189).
//
// Live captions already recognise both speakers in every captioned class
// (D-185): the speaker's own browser, or the other participant's computer, or
// — for two phones — a Deepgram stream from the speaker's browser. Each
// finished line used to exist only for the seconds it was on screen. With
// LESSON_INSIGHTS_TRANSCRIPTION_ENABLED on, the browser that recognised a line
// also POSTs its source text to /api/captions/transcript, and this module
// appends it to the booking's LessonTranscript — the same row, in the same
// shape, that the egress-and-ASR pipeline (pipeline.ts) used to produce, so
// Phase C (lesson insights) reads it unchanged. No audio is captured for it.
//
// Three properties, each load-bearing:
//
//   * CONSENT AT THE POINT OF CAPTURE (D-22). A line is kept only for a class
//     whose pairing has recorded insights consent (the guardian's for a minor,
//     and the buyer's for the second person of a class for two). That is
//     decided here, server-side, for both speakers: a teacher's own words are
//     not kept either without it, because a transcript of half a lesson is
//     a liability with no product value.
//   * TWO BROWSERS, ONE ROW. Both participants' browsers may be posting lines
//     at once (each recognises the speakers assigned to it), so the append is
//     one atomic INSERT … ON CONFLICT statement in Postgres rather than a
//     read-modify-write, which would lose lines under the race.
//   * FINALISED ONCE. While the class runs the row's `provider` is
//     "browser-live"; finalising (room_finished, or the Inngest fallback after
//     the scheduled end) rebases the timeline to 0 and flips it to "browser"
//     under a status guard, so two completion signals fire
//     `lesson.transcript.ready` exactly once, and a line that arrives after the
//     class is over is dropped by the same guard rather than appended to a
//     normalised transcript with an epoch timestamp.
//
// Timing is approximate by design. The browser recognisers give no word
// timestamps, so each line carries the client's estimate of how long it took
// to say (the gap since that speaker's previous line, capped), and the server
// stamps the end at receipt. Phase C orders by start and quotes text; it never
// needed millisecond accuracy, and the egress path's two-clock offset problem
// (each egress started on its own clock) does not arise when one server stamps
// every line.

const log = logger({ surface: "browser-transcript" });

// The row is being written to by the browsers of a class in progress.
export const BROWSER_TRANSCRIPT_LIVE = "browser-live";
// The row is complete, rebased to a 0-based timeline, and Phase C has been told.
export const BROWSER_TRANSCRIPT_PROVIDER = "browser";

// The longest one line may claim to have taken. A recogniser can hold a final
// back for a while, and a speaker's first line after a long silence would
// otherwise claim the silence.
export const MAX_LINE_DURATION_MS = 60_000;

type Db = Pick<PrismaClient, "$queryRaw" | "lessonTranscript" | "teacherStudent">;
type EventSender = Pick<typeof defaultInngest, "send">;

// Whether this class's recognised lines are to be kept as its transcript: the
// flag is on AND the pairing's insights consent is recorded (D-22). Fails
// closed on a missing pairing row, like the captions consent beside it.
export async function lessonTranscriptCaptureOk(
  db: Pick<Db, "teacherStudent">,
  booking: Pick<Booking, "teacherId" | "studentId"> & {
    package?: { seats: number; partnerConsentAt: Date | null } | null;
  },
): Promise<boolean> {
  if (!browserTranscriptEnabled()) return false;
  const pairing = await db.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: booking.teacherId, studentId: booking.studentId } },
    select: { isMinor: true, insightsConsentAt: true, guardianConsentAt: true },
  });
  if (!pairing) return false;
  return lessonInsightsConsentOk({
    isMinor: pairing.isMinor,
    insightsConsentAt: pairing.insightsConsentAt,
    guardianConsentAt: pairing.guardianConsentAt,
    classPackage: booking.package ?? undefined,
  });
}

export type TranscriptLineInput = {
  bookingId: string;
  teacherId: string;
  speaker: CallRole;
  // The recognised source text, verbatim (never the translation).
  text: string;
  // The client's estimate of how long the line took to say.
  durationMs: number;
  // Receipt time (epoch ms); injectable for tests.
  now?: number;
};

export type AppendOutcome = {
  // False when the row is no longer live (the class was finalised, or the row
  // belongs to the egress pipeline) — the line was dropped, not stored.
  kept: boolean;
  // True when this line created the row: the first line of the class, which
  // is the caller's cue to arm the completion fallback.
  started: boolean;
};

// The stored shape is Phase B's SpeakerUtterance (types.ts) so the transcript
// reads the same whichever path wrote it; `words` is empty because a browser
// recogniser has no word timings to give.
export function lineToUtterance(
  line: Pick<TranscriptLineInput, "speaker" | "text" | "durationMs">,
  endMs: number,
): SpeakerUtterance {
  const duration = Math.min(Math.max(0, Math.round(line.durationMs)), MAX_LINE_DURATION_MS);
  return {
    speaker: line.speaker,
    text: line.text.trim(),
    startMs: endMs - duration,
    endMs,
    words: [],
  };
}

export async function appendBrowserTranscriptLine(
  db: Pick<Db, "$queryRaw">,
  line: TranscriptLineInput,
): Promise<AppendOutcome> {
  const utterance = lineToUtterance(line, line.now ?? Date.now());
  if (!utterance.text) return { kept: false, started: false };
  const utterances = JSON.stringify([utterance]);
  // One statement, so two browsers appending at once cannot lose a line, and
  // so a line for a finished class (provider no longer live) is a no-op. The
  // teacher_id in the update's WHERE is the tenant scope (D-175); the insert
  // carries it as the row's own. `xmax = 0` is Postgres's tell for "this row
  // was inserted, not updated, by this statement".
  const rows = await db.$queryRaw<{ inserted: boolean }[]>`
    INSERT INTO lesson_transcripts (booking_id, teacher_id, language, utterances, provider)
    VALUES (
      ${line.bookingId}::uuid,
      ${line.teacherId}::uuid,
      ${DEFAULT_LESSON_LANGUAGE},
      ${utterances}::jsonb,
      ${BROWSER_TRANSCRIPT_LIVE}
    )
    ON CONFLICT (booking_id) DO UPDATE
      SET utterances = lesson_transcripts.utterances || EXCLUDED.utterances,
          updated_at = now()
      WHERE lesson_transcripts.provider = ${BROWSER_TRANSCRIPT_LIVE}
        AND lesson_transcripts.teacher_id = ${line.teacherId}::uuid
    RETURNING (xmax = 0) AS inserted
  `;
  const row = rows[0];
  if (!row) return { kept: false, started: false };
  return { kept: true, started: row.inserted === true };
}

export type FinalizeOutcome =
  | { code: "skipped"; reason: "no-live-transcript" | "already-final" | "empty" }
  | { code: "finalized"; utteranceCount: number };

// Close the class's browser-written transcript: rebase it to a 0-based
// timeline, mark it final, and fire `lesson.transcript.ready` for Phase C.
// Idempotent under the provider guard, so the room_finished webhook and the
// Inngest fallback can both call it. An empty row (captions were on but nobody
// said anything the recognisers kept) is deleted rather than analysed.
export async function finalizeBrowserTranscript(
  db: Pick<Db, "lessonTranscript">,
  inngest: EventSender,
  bookingId: string,
): Promise<FinalizeOutcome> {
  // tenancy-exempt: called from the video webhook and a background job, which
  // know only the room's booking id; the row's own teacher_id scopes the writes.
  const row = await db.lessonTranscript.findUnique({
    where: { bookingId },
    select: { id: true, teacherId: true, provider: true, utterances: true },
  });
  if (!row) return { code: "skipped", reason: "no-live-transcript" };
  if (row.provider !== BROWSER_TRANSCRIPT_LIVE) return { code: "skipped", reason: "already-final" };

  const utterances = Array.isArray(row.utterances)
    ? (row.utterances as unknown as SpeakerUtterance[])
    : [];
  if (utterances.length === 0) {
    await db.lessonTranscript.deleteMany({
      where: { id: row.id, teacherId: row.teacherId, provider: BROWSER_TRANSCRIPT_LIVE },
    });
    return { code: "skipped", reason: "empty" };
  }

  const normalized = normalizeTimeline(utterances);
  const updated = await db.lessonTranscript.updateMany({
    where: { id: row.id, teacherId: row.teacherId, provider: BROWSER_TRANSCRIPT_LIVE },
    data: {
      utterances: normalized as unknown as object,
      provider: BROWSER_TRANSCRIPT_PROVIDER,
    },
  });
  if (updated.count === 0) return { code: "skipped", reason: "already-final" };

  await inngest.send({ name: "lesson.transcript.ready", data: { bookingId } });
  log.info("browser transcript finalized", { bookingId, utteranceCount: normalized.length });
  return { code: "finalized", utteranceCount: normalized.length };
}
