import { presignS3Url } from "@/lib/aws/sigv4";
import { r2BucketConfig, r2ObjectPath } from "@/lib/storage/provider";

// Voice messages in the teacher↔student chat — stored in a dedicated Cloudflare
// R2 bucket ("chat-audio") rather than Supabase Storage. R2 has zero egress fees,
// which matters for audio: every press of play is an egress event. Supabase
// Storage charges ~$0.09/GB egress; R2 charges $0.
//
// Follows the same pattern as lesson-audio-store.ts (Phase B transcription): the
// Supabase storage seam can't address R2 buckets, so this is a thin direct client
// built on the existing SigV4 presigner. Two operations needed:
//   - putChatAudio: presigned PUT — server uploads from multipart form data
//   - mintChatAudioSignedUrl: presigned GET — returned to client for playback (24h TTL)
//
// Config: CHAT_AUDIO_R2_BUCKET + CHAT_AUDIO_R2_ENDPOINT + CHAT_AUDIO_R2_ACCESS_KEY
//         + CHAT_AUDIO_R2_SECRET (+ optional CHAT_AUDIO_R2_REGION, default "auto"),
// read via provider.ts's shared r2BucketConfig("chat-audio") rather than a
// hand-rolled process.env reader here — chat-video.ts shares the same bucket
// and config. Missing/invalid config degrades to upload-failed, not a boot error.

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24; // 24 hours
const PUT_TTL_SECONDS = 300; // 5 min — the upload itself completes server-side

// content-type → canonical extension for the formats MediaRecorder produces.
export const ALLOWED_AUDIO_TYPES: Record<string, string> = {
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/webm": "webm",
  "audio/webm;codecs=opus": "webm",
  "audio/ogg": "ogg",
  "audio/ogg;codecs=opus": "ogg",
};

function r2Config() {
  return r2BucketConfig("chat-audio");
}

// --- Direct (presigned) upload path -----------------------------------------
// Videos and long voice notes exceed Vercel's ~4.5 MB function request-body
// limit, so they can't be proxied through the API route. Instead the client
// asks for a presigned PUT URL, uploads straight to R2, then finalizes the
// message with just the storage path. These helpers mint that URL, validate a
// path the client hands back, and confirm the object actually landed.

/** Mint a presigned PUT URL + the (server-chosen) storage path for a new
 *  voice note. The path — never the client — decides where the object lands,
 *  scoped to the (teacher, student) pair so a client can't write outside its
 *  own thread. Returns an `error` if R2 isn't configured or the type is bad. */
export function presignChatAudioUpload(
  teacherId: string,
  studentId: string,
  contentType: string,
  timestamp: number,
): { uploadUrl: string; storagePath: string; error?: undefined } | { error: string } {
  const cfg = r2Config();
  if (!cfg) return { error: "r2-not-configured" };
  const ext = ALLOWED_AUDIO_TYPES[contentType];
  if (!ext) return { error: "bad-type" };
  const storagePath = `${teacherId}/${studentId}/${timestamp}.${ext}`;
  const uploadUrl = presignS3Url({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    host: cfg.host,
    method: "PUT",
    path: r2ObjectPath(cfg, storagePath),
    expiresInSeconds: PUT_TTL_SECONDS,
    now: new Date(),
  });
  return { uploadUrl, storagePath };
}

/** Guard a client-supplied storage path on finalize: it must sit exactly under
 *  this thread's prefix (no traversal, no nesting) and carry an allowed audio
 *  extension. Prevents a caller from attaching an arbitrary or cross-thread
 *  object to their message. */
export function isChatAudioPath(
  storagePath: string,
  teacherId: string,
  studentId: string,
): boolean {
  const prefix = `${teacherId}/${studentId}/`;
  if (!storagePath.startsWith(prefix)) return false;
  const rest = storagePath.slice(prefix.length);
  if (rest.length === 0 || rest.includes("/") || rest.includes("..")) return false;
  const ext = rest.split(".").pop() ?? "";
  return Object.values(ALLOWED_AUDIO_TYPES).includes(ext);
}

/** HEAD the uploaded object so finalize can (a) confirm the client actually
 *  uploaded it before we persist a message pointing at it — a dangling voice
 *  bubble is worse than a failed send — and (b) read its size, since a
 *  presigned PUT can't cap its own body. Returns the byte size, or null if the
 *  object isn't there. */
export async function headChatAudioObject(storagePath: string): Promise<number | null> {
  const cfg = r2Config();
  if (!cfg) return null;
  const url = presignS3Url({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    host: cfg.host,
    method: "HEAD",
    path: r2ObjectPath(cfg, storagePath),
    expiresInSeconds: PUT_TTL_SECONDS,
    now: new Date(),
  });
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length"));
    return Number.isFinite(len) ? len : 0;
  } catch {
    return null;
  }
}

export async function mintChatAudioSignedUrl(storagePath: string): Promise<string | null> {
  const cfg = r2Config();
  if (!cfg) return null;

  return presignS3Url({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    host: cfg.host,
    method: "GET",
    path: r2ObjectPath(cfg, storagePath),
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    now: new Date(),
  });
}

/** Delete a voice-note object when its message is deleted-for-everyone. Best
 *  effort: an orphaned object costs pennies and already-minted 24h signed URLs
 *  keep working regardless, so callers treat `false` as log-and-continue —
 *  never as a reason to fail the delete. S3 DELETE is 204 on success and on
 *  already-gone keys alike, so this is naturally idempotent. */
export async function deleteChatAudioObject(storagePath: string): Promise<boolean> {
  const cfg = r2Config();
  if (!cfg) return false;
  const url = presignS3Url({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    host: cfg.host,
    method: "DELETE",
    path: r2ObjectPath(cfg, storagePath),
    expiresInSeconds: PUT_TTL_SECONDS,
    now: new Date(),
  });
  try {
    const res = await fetch(url, { method: "DELETE" });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}
