import { presignS3Url } from "@/lib/aws/sigv4";
import {
  getStorageProvider,
  r2BucketConfig,
  r2ObjectPath,
  PUBLIC_VERSIONED_ASSET_CACHE_CONTROL,
} from "./provider";
import { r2PublicUrl } from "./r2-public-url";

// Teacher intro videos live in a PUBLIC bucket, exactly like teacher photos:
// the booking page (/b/<slug>) is public and unauthenticated visitors (and
// social/OG crawlers) fetch the file directly, so a signed URL that expires
// won't survive the SSR/CDN cache. One object per teacher, keyed by id, so a
// re-record replaces in place (no orphans); a `?v=` cache-buster (teacher
// updatedAt) busts the CDN copy after a re-upload.
//
// This deliberately mirrors lib/storage/teacher-photo.ts rather than the
// private/signed chat-video.ts: an intro video is public, permanent, and served
// straight from the R2 public host to <video> — no third-party embed. See D-73.

export const TEACHER_VIDEO_BUCKET = "teacher-videos";
// 50 MB accommodates ~60s of phone-quality selfie video at typical
// MediaRecorder bitrates (~6–8 Mbps), matching the chat-video cap.
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB

// content-type → extension for the allowed video formats. mp4 (mobile / most
// uploads), webm (web MediaRecorder), quicktime/mov (iOS uploads).
export const ALLOWED_VIDEO_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/webm;codecs=vp8,opus": "webm",
  "video/webm;codecs=vp9,opus": "webm",
  "video/webm;codecs=av1,opus": "webm",
};

// One object per teacher, keyed by id (no extension) — the stored Content-Type
// drives playback, and keying by id means a re-record replaces in place.
export function teacherVideoStorageKey(teacherId: string): string {
  return `${teacherId}`;
}

// Public URL for a stored intro video. `version` (e.g. teacher.updatedAt) busts
// the CDN cache after a re-record. Returns null when there's no video or the
// backend URL isn't configured — the caller then hides the video affordance.
// Credential-free, safe to call during render.
export function teacherVideoPublicUrl(
  videoPath: string | null | undefined,
  version?: number,
): string | null {
  return r2PublicUrl(TEACHER_VIDEO_BUCKET, videoPath, version);
}

// Whether the intro-video feature is usable at all — i.e. the public bucket's
// URL base is configured. When it isn't (dev, or before the R2 bucket is
// provisioned in prod), the editor hides the recorder and the public page skips
// the video section, exactly like getVideoProvider()/recordingEnabled() degrade.
export function introVideoStorageConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_TEACHER_VIDEOS_R2_PUBLIC_URL?.trim());
}

// Idempotently ensure the public bucket exists (self-provisions preview / dev on
// the Supabase seam; a no-op on R2, where buckets are created out-of-band).
export async function ensureTeacherVideoBucket(): Promise<void> {
  await getStorageProvider().ensureBucket(TEACHER_VIDEO_BUCKET, {
    public: true,
    fileSizeLimit: MAX_VIDEO_BYTES,
    allowedMimeTypes: Object.keys(ALLOWED_VIDEO_TYPES),
  });
}

// Stores a teacher's intro video (one object per teacher, replace in place) and
// returns its storage key. Callers never touch the storage backend directly,
// and validate type/size
// first; this provisions the bucket then uploads.
export async function putTeacherVideo(
  teacherId: string,
  file: File | Blob,
  contentType: string,
): Promise<{ path: string; error: string | null }> {
  await ensureTeacherVideoBucket();
  const path = teacherVideoStorageKey(teacherId);
  const { error } = await getStorageProvider().upload(TEACHER_VIDEO_BUCKET, path, file, {
    contentType,
    upsert: true,
    // Safe long cache here specifically because the public URL always carries
    // a `?v=` cache-buster (teacherVideoPublicUrl) — see provider.ts. The
    // presigned direct-to-R2 upload path below doesn't go through this PUT,
    // so it's unaffected.
    cacheControl: PUBLIC_VERSIONED_ASSET_CACHE_CONTROL,
  });
  return { path, error: error?.message ?? null };
}

// Best-effort removal of a teacher's intro-video object (hard delete). Mirrors
// putTeacherVideo so a cleared pointer doesn't leak the stored object.
export async function removeTeacherVideo(videoPath: string): Promise<void> {
  await getStorageProvider()
    .remove(TEACHER_VIDEO_BUCKET, [videoPath])
    .catch(() => {});
}

// --- Direct (presigned) upload path -----------------------------------------
// A gallery/library video easily exceeds the serverless request-body limit, so
// the buffered `putTeacherVideo` (multipart through the function) 500s on large
// files. Mirroring the chat-video flow, the client instead GETs a presigned PUT
// URL, uploads the bytes STRAIGHT to R2, then finalizes by path — the bytes
// never pass through the function. One object per teacher (the id key), so a
// re-upload replaces in place, same as the buffered path.

const PUT_TTL_SECONDS = 300;

// Mint a presigned PUT URL for the teacher's intro-video object. The key is
// server-derived (the teacher id), so a caller can only ever write their own
// object. Returns { error } when R2 isn't configured or the type isn't allowed.
export function presignTeacherVideoUpload(
  teacherId: string,
  contentType: string,
): { uploadUrl: string; storagePath: string; error?: undefined } | { error: string } {
  const cfg = r2BucketConfig(TEACHER_VIDEO_BUCKET);
  if (!cfg) return { error: "r2-not-configured" };
  if (!ALLOWED_VIDEO_TYPES[contentType]) return { error: "bad-type" };
  const storagePath = teacherVideoStorageKey(teacherId);
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

// HEAD the uploaded object at finalize: confirm it exists and read its size (a
// presigned PUT can't cap its own body). Returns byte size, or null if missing.
export async function headTeacherVideoObject(storageKey: string): Promise<number | null> {
  const cfg = r2BucketConfig(TEACHER_VIDEO_BUCKET);
  if (!cfg) return null;
  const url = presignS3Url({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    host: cfg.host,
    method: "HEAD",
    path: r2ObjectPath(cfg, storageKey),
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
