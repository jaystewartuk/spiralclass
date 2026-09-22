import { presignS3Url } from "@/lib/aws/sigv4";

// Document attachments in the teacher↔student chat — same R2 bucket as chat
// audio/video/image ("chat-audio" / CHAT_AUDIO_R2_*), under a `file/` key
// prefix. Mirrors chat-image.ts exactly. Deliberately no executable/script
// mime types in the allowlist.

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24; // 24 hours
const PUT_TTL_SECONDS = 300;

export const ALLOWED_FILE_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "application/zip": "zip",
};

type R2Config = {
  bucket: string;
  host: string;
  region: string;
  accessKey: string;
  secret: string;
};

function r2Config(): R2Config | null {
  const bucket = process.env.CHAT_AUDIO_R2_BUCKET?.trim();
  const endpoint = process.env.CHAT_AUDIO_R2_ENDPOINT?.trim();
  const region = process.env.CHAT_AUDIO_R2_REGION?.trim() || "auto";
  const accessKey = process.env.CHAT_AUDIO_R2_ACCESS_KEY?.trim();
  const secret = process.env.CHAT_AUDIO_R2_SECRET?.trim();
  if (!bucket || !endpoint || !accessKey || !secret) {
    const missing = [
      !bucket && "CHAT_AUDIO_R2_BUCKET",
      !endpoint && "CHAT_AUDIO_R2_ENDPOINT",
      !accessKey && "CHAT_AUDIO_R2_ACCESS_KEY",
      !secret && "CHAT_AUDIO_R2_SECRET",
    ].filter(Boolean);
    console.error("[chat-file] r2 not configured — missing:", missing.join(", "));
    return null;
  }
  let host: string;
  try {
    host = new URL(endpoint).host;
  } catch {
    console.error("[chat-file] CHAT_AUDIO_R2_ENDPOINT is not a valid URL:", endpoint);
    return null;
  }
  return { bucket, host, region, accessKey, secret };
}

function s3Path(cfg: R2Config, objectKey: string): string {
  return `/${cfg.bucket}/${objectKey}`;
}

/** Mint a presigned PUT URL + server-chosen storage path for a new document. */
export function presignChatFileUpload(
  teacherId: string,
  studentId: string,
  contentType: string,
  timestamp: number,
): { uploadUrl: string; storagePath: string; error?: undefined } | { error: string } {
  const cfg = r2Config();
  if (!cfg) return { error: "r2-not-configured" };
  const ext = ALLOWED_FILE_TYPES[contentType];
  if (!ext) return { error: "bad-type" };
  const storagePath = `file/${teacherId}/${studentId}/${timestamp}.${ext}`;
  const uploadUrl = presignS3Url({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    host: cfg.host,
    method: "PUT",
    path: s3Path(cfg, storagePath),
    expiresInSeconds: PUT_TTL_SECONDS,
    now: new Date(),
  });
  return { uploadUrl, storagePath };
}

/** Guard a client-supplied file path on finalize: exactly under this thread's
 *  `file/<teacher>/<student>/` prefix, no traversal, allowed extension. */
export function isChatFilePath(storagePath: string, teacherId: string, studentId: string): boolean {
  const prefix = `file/${teacherId}/${studentId}/`;
  if (!storagePath.startsWith(prefix)) return false;
  const rest = storagePath.slice(prefix.length);
  if (rest.length === 0 || rest.includes("/") || rest.includes("..")) return false;
  const ext = rest.split(".").pop() ?? "";
  return Object.values(ALLOWED_FILE_TYPES).includes(ext);
}

/** HEAD the uploaded object: confirm it exists and read its size. Returns
 *  byte size, or null if missing. */
export async function headChatFileObject(storagePath: string): Promise<number | null> {
  const cfg = r2Config();
  if (!cfg) return null;
  const url = presignS3Url({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    host: cfg.host,
    method: "HEAD",
    path: s3Path(cfg, storagePath),
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

export async function mintChatFileSignedUrl(storagePath: string): Promise<string | null> {
  const cfg = r2Config();
  if (!cfg) return null;

  return presignS3Url({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    host: cfg.host,
    method: "GET",
    path: s3Path(cfg, storagePath),
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    now: new Date(),
  });
}

/** Delete a file object when its message is deleted-for-everyone. Best
 *  effort and idempotent — see deleteChatAudioObject for the rationale. */
export async function deleteChatFileObject(storagePath: string): Promise<boolean> {
  const cfg = r2Config();
  if (!cfg) return false;
  const url = presignS3Url({
    accessKeyId: cfg.accessKey,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    host: cfg.host,
    method: "DELETE",
    path: s3Path(cfg, storagePath),
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
