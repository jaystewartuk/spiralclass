import { getVideoProvider } from "@/lib/video/providers";

// Call recording via the active video provider's egress/recording API
// (live-notes-panel.md step 3 follow-up). A teacher-initiated room-composite
// recording records the class; audio-only per-participant recording is the
// lesson-insights supplement. Kept behind this seam like the rest of the
// video layer: callers ask `recordingEnabled()` and degrade to a hidden
// control when it isn't configured, exactly like getVideoProvider().
//
// As of docs/features/live-calls-video.md, this
// routes through the active VideoProvider instead of constructing a LiveKit
// EgressClient/S3Upload directly — same exported function names/signatures,
// unchanged, so lib/video/call-recording.ts and lib/video/lesson-audio.ts
// needed no changes at all. The LiveKit-specific egress/R2 wiring now lives in
// lib/video/providers/livekit-provider.ts.

// Explicit enablement flag for class recording, OFF by default — mirrors
// LIVE_CAPTIONS_ENABLED (captions/config.ts). Recording a live lesson carries
// the same consent/privacy weight as captioning it (D-21/D-22), hence a flag
// rather than "on because the provider happens to be configured for it".
// Non-secret, so it lives in the committed runtime env files
// (config/env/*.runtime.env), not Infisical. Accepts 1/true/on (any case).
function classRecordingFlagOn(): boolean {
  const raw = process.env.CLASS_RECORDING_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

// Recording needs the explicit flag AND the active provider to be able to
// record (i.e. its recording backend + storage destination are configured).
// A call can be live (getVideoProvider) — and lesson-insights audio egress can
// run (it gates on the provider's recordingConfigured() directly, NOT this) —
// without class recording being offered. Gating the flag here means the
// Record control is hidden (teacher web page / mobile call-token
// `recordingAvailable`) AND the start is refused server-side, all from one
// switch.
export function recordingEnabled(): boolean {
  if (!classRecordingFlagOn()) return false;
  const provider = getVideoProvider();
  return provider !== null && provider.recordingConfigured();
}

// Object key for a participant's analysis audio (lesson insights Phase A). One
// OGG/Opus file per speaker per booking; `token` (a start-time timestamp, like
// the call-recording key) keeps repeated Record sessions from colliding.
export function lessonAudioKey(bookingId: string, speaker: string, token: string): string {
  return `lesson-audio/${bookingId}/${speaker}-${token}.ogg`;
}

// Object key for a class's room-composite recording. `.m4a` — the composite is
// AUDIO-ONLY as of D-135, and the extension is load-bearing: it is the only
// thing that distinguishes a new audio recording from a legacy `.mp4` one
// recorded before the change, both of which still sit in the same bucket and
// still have to play. `token` is a start-time timestamp, so repeated Record
// sessions on one booking never collide.
export function callRecordingKey(bookingId: string, token: string): string {
  return `recordings/${bookingId}/${token}.m4a`;
}

// Does this stored recording hold audio only? Legacy rows (before D-135) are
// `.mp4` room composites WITH video and must keep rendering in a video player;
// everything written since is `.m4a`. Kept a pure string check so the replay
// page can decide server-side without loading a provider.
export function isAudioOnlyRecordingKey(storageKey: string | null | undefined): boolean {
  return storageKey?.toLowerCase().endsWith(".m4a") ?? false;
}

// Start recording a room to `<storageKey>` in the provider's egress bucket.
// Returns the recording id (used to stop it) and the key (stored on the
// recording row).
export async function startRoomRecording(
  room: string,
  storageKey: string,
): Promise<{ egressId: string; storageKey: string }> {
  const provider = getVideoProvider();
  if (!provider) throw new Error("recording-not-configured");
  const handle = await provider.startRoomRecording(room, storageKey);
  return { egressId: handle.providerRecordingId, storageKey: handle.storageKey };
}

// Start an audio-ONLY recording for one participant's microphone track
//. Audio-only is
// small and cheap and is the ideal input for ASR. `trackId` is the
// participant's microphone track SID, resolved by lib/video/room.ts. Returns
// the recording id (used to stop it) and the key (stored on the LessonAudio
// row). Deliberately independent of `recordingEnabled()`/
// `CLASS_RECORDING_ENABLED` — only the provider's own recordingConfigured()
// gates this, same as before the refactor.
export async function startParticipantAudioEgress(
  room: string,
  trackId: string,
  storageKey: string,
): Promise<{ egressId: string; storageKey: string }> {
  const provider = getVideoProvider();
  if (!provider) throw new Error("recording-not-configured");
  const handle = await provider.startParticipantRecording(room, trackId, storageKey);
  return { egressId: handle.providerRecordingId, storageKey: handle.storageKey };
}

// Stop a running recording (audio track or room composite — same API).
// Best-effort: if no provider is configured (keys pulled) there's nothing to
// stop.
export async function stopEgress(egressId: string): Promise<void> {
  const provider = getVideoProvider();
  if (!provider) return;
  await provider.stopRecording(egressId);
}

// Stop a room-composite recording. Thin alias over stopEgress kept for
// call-site clarity (and back-compat) — the underlying stop is identical.
export async function stopRoomRecording(egressId: string): Promise<void> {
  await stopEgress(egressId);
}
