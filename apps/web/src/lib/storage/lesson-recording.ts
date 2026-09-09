import { getStorageProvider } from "./provider";

// Signed playback URL for a completed CallRecording (lesson replay). The
// recording lives in the same R2 bucket the LiveKit egress writes to — see
// R2_ENV_PREFIX's "recordings" entry in provider.ts (env-var prefix
// LIVEKIT_EGRESS_S3_*) and lib/video/recording.ts's startRoomRecording, which
// is what first creates the object at CallRecording.storageKey. Kept as its
// own module (mirrors student-photo.ts) rather than inlined at each replay
// call site, so web + mobile share exactly one TTL/bucket decision.

export const RECORDINGS_BUCKET = "recordings";
// A replay session can run long (a teacher scrubbing through a full class) —
// generous relative to the 5-minute materials TTL, short of the 7-day
// materials-link TTL since a recording is far more sensitive than a PDF.
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 4;

export async function lessonRecordingUrl(
  storageKey: string | null | undefined,
): Promise<string | null> {
  if (!storageKey) return null;
  return getStorageProvider().createSignedUrl(
    RECORDINGS_BUCKET,
    storageKey,
    SIGNED_URL_TTL_SECONDS,
  );
}
