import { presignS3Url } from "@/lib/aws/sigv4";
import { r2BucketConfig, r2ObjectPath } from "@/lib/storage/provider";

// Selfie video messages in the teacher↔student chat — stored in the same
// Cloudflare R2 bucket as chat audio ("chat-audio" / CHAT_AUDIO_R2_*, read via
// provider.ts's shared r2BucketConfig("chat-audio")) to keep a single
// chat-media bucket. Videos live under a "video/" key prefix.
//
// Size limit is 50 MB (vs 10 MB for audio) to accommodate up to ~60s of
// phone-quality selfie video at typical camera bitrates (~6–8 Mbps).

// 100 MB — comfortably fits a full 60s selfie clip at phone camera bitrates.
// Uploads go direct-to-R2 (presigned), so this is no longer bounded by
// Vercel's ~4.5 MB function body limit; it's just an abuse guard checked
// against the object's Content-Length at finalize.
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24; // 24 hours
const PUT_TTL_SECONDS = 300;

export const ALLOWED_VIDEO_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/webm;codecs=vp8,opus": "webm",
  "video/webm;codecs=vp9,opus": "webm",
  "video/webm;codecs=av1,opus": "webm",
};

function r2Config() {
  return r2BucketConfig("chat-audio");
}

// --- Direct (presigned) upload path -----------------------------------------
// Video always exceeds Vercel's ~4.5 MB function request-body limit, so it is
// uploaded straight to R2 via a presigned PUT and then finalized by path.
// Mirrors the chat-audio helpers; videos live under the `video/` key prefix.

/** Mint a presigned PUT URL + server-chosen storage path for a new video. */
export function presignChatVideoUpload(
  teacherId: string,
  studentId: string,
  contentType: string,
  timestamp: number,
): { uploadUrl: string; storagePath: string; error?: undefined } | { error: string } {
  const cfg = r2Config();
  if (!cfg) return { error: "r2-not-configured" };
  const ext = ALLOWED_VIDEO_TYPES[contentType];
  if (!ext) return { error: "bad-type" };
  const storagePath = `video/${teacherId}/${studentId}/${timestamp}.${ext}`;
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

/** Guard a client-supplied video path on finalize: exactly under this thread's
 *  `video/<teacher>/<student>/` prefix, no traversal, allowed extension. */
export function isChatVideoPath(
  storagePath: string,
  teacherId: string,
  studentId: string,
): boolean {
  const prefix = `video/${teacherId}/${studentId}/`;
  if (!storagePath.startsWith(prefix)) return false;
  const rest = storagePath.slice(prefix.length);
  if (rest.length === 0 || rest.includes("/") || rest.includes("..")) return false;
  const ext = rest.split(".").pop() ?? "";
  return Object.values(ALLOWED_VIDEO_TYPES).includes(ext);
}

/** HEAD the uploaded object: confirm it exists and read its size (a presigned
 *  PUT can't cap its own body). Returns byte size, or null if missing. */
export async function headChatVideoObject(storagePath: string): Promise<number | null> {
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

export async function mintChatVideoSignedUrl(storagePath: string): Promise<string | null> {
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

/** Delete a video object when its message is deleted-for-everyone. Best
 *  effort and idempotent — see deleteChatAudioObject for the rationale. */
export async function deleteChatVideoObject(storagePath: string): Promise<boolean> {
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
