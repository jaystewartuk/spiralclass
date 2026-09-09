import "server-only";

import { presignS3Url } from "@/lib/aws/sigv4";
import { r2BucketConfig, r2ObjectPath, type R2BucketConfig } from "@/lib/storage/provider";

// Homework submission files — private objects in the shared `class-materials`
// R2 bucket (already provisioned; the admin browser allowlists it), under a
// `homework/` key prefix so they never collide with teacher-authored class
// materials. Modelled on chat-file.ts's presigned direct-to-R2 flow: the mobile
// client PUTs the bytes straight to R2 (bypassing Vercel's ~4.5 MB function
// body limit), then the finalize route re-validates the server-chosen path and
// HEADs the object for its real size before writing the DB row.
//
// Files are downloaded only through a short-lived signed GET URL minted for the
// owning student or an authorized teacher — never public.

// Reuse the class-materials bucket rather than a new one: adding a bucket needs
// infra (Terraform) + env provisioning that doesn't exist in preview/prod yet,
// and this bucket is already the private "per-booking attachments" store.
const HOMEWORK_BUCKET = "class-materials";

export const MAX_SUBMISSION_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24; // 24 hours
const PUT_TTL_SECONDS = 300;

// The homework file types students can hand in. PDF + Word are the required
// set; images and plain text are the optional extras the task allows. Audio
// (slice 5/7, docs/features/homework.md's advice on enabling
// audio now" call) reuses the exact MIME set already accepted for chat voice
// messages (ALLOWED_AUDIO_TYPES, chat-audio.ts) — a spoken answer for a
// language-tutoring product is a strong fit, and the transcription pipeline
// (lib/transcription/) already exists for this exact shape of problem. No
// executable/script/archive types — a submission is a document, not a payload.
export const ALLOWED_SUBMISSION_FILE_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/jpeg": "jpg",
  "image/png": "png",
  "text/plain": "txt",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
};

function config(): R2BucketConfig | null {
  return r2BucketConfig(HOMEWORK_BUCKET);
}

// Where an object lives: homework/<teacher>/<assignment>/<student>/<ts>.<ext>.
// Every id is a server-known value (never client-supplied), and the finalize
// guard re-derives this exact prefix, so a client can't smuggle a path into
// another student's or assignment's space.
function objectPrefix(teacherId: string, assignmentId: string, studentId: string): string {
  return `homework/${teacherId}/${assignmentId}/${studentId}/`;
}

/** Mint a presigned PUT URL + server-chosen storage path for a new file. */
export function presignSubmissionUpload(
  teacherId: string,
  assignmentId: string,
  studentId: string,
  contentType: string,
  timestamp: number,
): { uploadUrl: string; storagePath: string } | { error: string } {
  const cfg = config();
  if (!cfg) return { error: "r2-not-configured" };
  const ext = ALLOWED_SUBMISSION_FILE_TYPES[contentType];
  if (!ext) return { error: "bad-type" };
  const storagePath = `${objectPrefix(teacherId, assignmentId, studentId)}${timestamp}.${ext}`;
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

/** Guard a client-supplied path on finalize: exactly under this student's
 *  assignment prefix, no traversal, allowed extension. */
export function isSubmissionFilePath(
  storagePath: string,
  teacherId: string,
  assignmentId: string,
  studentId: string,
): boolean {
  const prefix = objectPrefix(teacherId, assignmentId, studentId);
  if (!storagePath.startsWith(prefix)) return false;
  const rest = storagePath.slice(prefix.length);
  if (rest.length === 0 || rest.includes("/") || rest.includes("..")) return false;
  const ext = rest.split(".").pop() ?? "";
  return Object.values(ALLOWED_SUBMISSION_FILE_TYPES).includes(ext);
}

/** HEAD the uploaded object: confirm it exists and read its byte size, or null
 *  when it's missing (the client claimed an upload that never landed). */
export async function headSubmissionObject(storagePath: string): Promise<number | null> {
  const cfg = config();
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

/** Short-lived signed GET URL for viewing/downloading a submission file. */
export async function mintSubmissionSignedUrl(storagePath: string): Promise<string | null> {
  const cfg = config();
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

/** Delete a file object when its row is removed. Best-effort + idempotent (a
 *  404 counts as success — the object may already be gone). */
export async function deleteSubmissionObject(storagePath: string): Promise<boolean> {
  const cfg = config();
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
