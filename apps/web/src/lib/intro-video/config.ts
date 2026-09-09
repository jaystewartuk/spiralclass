import { transcriptionConfig } from "@/lib/transcription/config";

// Intro-video AI coach enablement (D-73, Layer 2). Deliberately a SEPARATE gate
// from the lesson-insights transcription flag (`LESSON_INSIGHTS_TRANSCRIPTION_ENABLED`):
// the intro video is the teacher's OWN public clip — no student data, no minors —
// so it is not blocked on the D-19 consent/retention sign-off. It still needs an
// explicit on-switch AND a configured ASR vendor before any bytes are sent, so a
// misconfiguration can never quietly start spending vendor minutes.
//
// Read straight from process.env (like transcription/config.ts, recording.ts and
// teacher-video.ts) so an availability check never depends on the whole env
// schema validating.

function coachFlagOn(): boolean {
  const raw = process.env.INTRO_VIDEO_COACH_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

// The single gate the intro-video pipeline checks: the flag is on AND an ASR
// vendor is configured. False leaves the whole pipeline dormant — the
// `intro-video.ready` Inngest handler logs and returns without touching a vendor.
export function introVideoCoachEnabled(): boolean {
  return coachFlagOn() && transcriptionConfig() !== null;
}
