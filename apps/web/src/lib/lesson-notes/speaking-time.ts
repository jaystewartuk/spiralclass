import type { SpeakerUtterance } from "@/lib/transcription/types";

// Speaking-time / participation analytics (D-97) — teacher-vs-student talk
// time and the listening/speaking balance for one lesson. Pure and
// unit-tested: `durationMs` (from LessonAudio, one row per speaker) anchors
// the lesson's total length, `utterances` (from LessonTranscript, already
// merged onto one 0-based timeline — lib/transcription/merge.ts) gives the
// actual talk segments per speaker. Using BOTH matters: durationMs alone
// can't split speaker vs. speaker, and utterances alone can't say how much of
// the lesson was silence/overlap on either side.

export type SpeakingTimeSummary = {
  totalMs: number;
  teacherSpeakingMs: number;
  studentSpeakingMs: number;
  // Share of totalMs each speaker was talking (0-100, rounded). Don't have to
  // sum to 100 — the remainder is silence, overlap, or untranscribed gaps.
  teacherSharePct: number;
  studentSharePct: number;
};

export function computeSpeakingTime(
  audios: { durationMs: number | null }[],
  utterances: SpeakerUtterance[],
): SpeakingTimeSummary | null {
  const totalMs = audios.reduce((max, a) => Math.max(max, a.durationMs ?? 0), 0);
  if (totalMs <= 0) return null;

  let teacherMs = 0;
  let studentMs = 0;
  for (const u of utterances) {
    const dur = Math.max(0, u.endMs - u.startMs);
    if (u.speaker === "teacher") teacherMs += dur;
    else studentMs += dur;
  }
  // Clamp: an ASR quirk or a stale audio row could otherwise push a share
  // over the lesson's own total length.
  teacherMs = Math.min(teacherMs, totalMs);
  studentMs = Math.min(studentMs, totalMs);

  return {
    totalMs,
    teacherSpeakingMs: teacherMs,
    studentSpeakingMs: studentMs,
    teacherSharePct: Math.round((teacherMs / totalMs) * 100),
    studentSharePct: Math.round((studentMs / totalMs) * 100),
  };
}
