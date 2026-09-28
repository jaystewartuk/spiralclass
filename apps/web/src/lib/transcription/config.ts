// Transcription config + the Phase B enablement gate (lesson-insights Phase B,
// the Phase B design, D-19).
//
// Two independent conditions must BOTH hold before any lesson audio is ever sent
// to an ASR vendor or any transcript is stored:
//   1. A vendor is configured (an API key is present).
//   2. The explicit enablement flag is on.
// The flag exists so Phase B stays off by default: the code can ship and the
// vendor key can be set, but until the flag is flipped the pipeline stays
// dormant and the Inngest handler falls back to Phase A log-only behaviour.
//
// Keys are read straight from process.env (like provider.ts / recording.ts) so
// an availability check never depends on the whole env schema validating.

import { deepgramApiKey } from "@/lib/captions/config";

export type TranscriptionVendor = "deepgram" | "assemblyai";

export type TranscriptionConfig = {
  vendor: TranscriptionVendor;
  apiKey: string;
};

// The lesson's target language. Spanish-first (D-19) — there is no per-lesson
// target-language field yet, so default to Spanish until one is added.
export const DEFAULT_LESSON_LANGUAGE = "es";

// Which vendor is configured, if any. Deepgram wins when both keys are present
// (arbitrary, swappable — the bake-off picks the real default).
export function transcriptionConfig(): TranscriptionConfig | null {
  const deepgram = deepgramApiKey();
  if (deepgram) return { vendor: "deepgram", apiKey: deepgram };
  const assembly = process.env.ASSEMBLYAI_API_KEY?.trim();
  if (assembly) return { vendor: "assemblyai", apiKey: assembly };
  return null;
}

function enablementFlagOn(): boolean {
  const raw = process.env.LESSON_INSIGHTS_TRANSCRIPTION_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

// The gate for the transcript that lesson insights read today (D-189): the
// participants' browsers already recognise both speakers for live captions,
// and with this flag on that recognised text is KEPT as the class's
// LessonTranscript instead of being thrown away with the captions. No audio
// is captured and no vendor is called for it, so the flag alone decides —
// captions' own gates (LIVE_CAPTIONS_ENABLED, the teacher's toggle, the Pro
// plan) and the per-pairing insights consent (D-22) still apply on top,
// resolved per class in lib/captions/class-access.ts.
export function browserTranscriptEnabled(): boolean {
  return enablementFlagOn();
}

// The gate for the AUDIO pipeline (Phase B): per-speaker audio captured by a
// LiveKit egress, sent to an ASR vendor, then discarded. Both a vendor AND the
// flag are required — see the module note on why the flag exists. Since D-189
// this path is dormant in production: the box has no egress (D-187), and
// call-recording.ts's maybeStartLessonAudioCapture additionally requires
// recording to be enabled before it starts one.
export function transcriptionEnabled(): boolean {
  return enablementFlagOn() && transcriptionConfig() !== null;
}

// Separate gate for homework audio-answer transcription (slice 7,
// docs/features/homework.md). Deliberately its OWN flag, not a
// reuse of LESSON_INSIGHTS_TRANSCRIPTION_ENABLED above: that flag governs
// capturing and transcribing a live CLASS recording — a different consent
// context from a student voluntarily attaching an audio file as their own
// homework answer
// (the same act as recording a chat voice message, which needs no such
// gate). Same vendor detection (transcriptionConfig()) either way — only the
// enablement flag differs.
function homeworkAudioEnablementFlagOn(): boolean {
  const raw = process.env.HOMEWORK_AUDIO_TRANSCRIPTION_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

export function homeworkAudioTranscriptionEnabled(): boolean {
  return homeworkAudioEnablementFlagOn() && transcriptionConfig() !== null;
}
