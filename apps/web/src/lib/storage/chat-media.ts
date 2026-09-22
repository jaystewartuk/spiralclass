// Shared server helpers for the presigned (direct-to-R2) chat-media upload,
// used by every mobile + web voice/video route so the presign + finalize
// validation lives in one place. Message creation and notification enqueue
// stay per-route (they differ by direction and media kind).
//
// Flow: client GETs a presigned PUT ticket → uploads straight to R2 (bypassing
// Vercel's ~4.5 MB function body limit) → POSTs the storage path back to
// finalize. Finalize re-derives trust from the authenticated (teacher, student)
// pair — never from the client — so a caller can only attach an object it
// uploaded, under its own thread's prefix, within the size cap.

import {
  MAX_AUDIO_BYTES,
  headChatAudioObject,
  isChatAudioPath,
  presignChatAudioUpload,
} from "./chat-audio";
import {
  MAX_VIDEO_BYTES,
  headChatVideoObject,
  isChatVideoPath,
  presignChatVideoUpload,
} from "./chat-video";
import {
  MAX_IMAGE_BYTES,
  headChatImageObject,
  isChatImagePath,
  presignChatImageUpload,
} from "./chat-image";
import {
  MAX_FILE_BYTES,
  headChatFileObject,
  isChatFilePath,
  presignChatFileUpload,
} from "./chat-file";

export type ChatMediaKind = "voice" | "video" | "image" | "file";

export type PresignResult =
  { uploadUrl: string; storagePath: string; error?: undefined } | { error: string };

/** Mint a presigned PUT ticket for a new voice/video object. The path is
 *  server-chosen and scoped to (teacher, student). */
export function presignChatMedia(
  kind: ChatMediaKind,
  teacherId: string,
  studentId: string,
  contentType: string,
  timestamp: number,
): PresignResult {
  switch (kind) {
    case "voice":
      return presignChatAudioUpload(teacherId, studentId, contentType, timestamp);
    case "video":
      return presignChatVideoUpload(teacherId, studentId, contentType, timestamp);
    case "image":
      return presignChatImageUpload(teacherId, studentId, contentType, timestamp);
    case "file":
      return presignChatFileUpload(teacherId, studentId, contentType, timestamp);
  }
}

/** Validate a client-supplied storage path at finalize: correct thread prefix,
 *  the object actually exists in R2, and it's within the size cap. */
export async function validateChatMediaUpload(
  kind: ChatMediaKind,
  storagePath: string,
  teacherId: string,
  studentId: string,
): Promise<{ ok: true } | { ok: false; reason: "bad-path" | "not-uploaded" | "too-large" }> {
  const pathValidators: Record<ChatMediaKind, (p: string, t: string, s: string) => boolean> = {
    voice: isChatAudioPath,
    video: isChatVideoPath,
    image: isChatImagePath,
    file: isChatFilePath,
  };
  if (!pathValidators[kind](storagePath, teacherId, studentId))
    return { ok: false, reason: "bad-path" };

  const headers: Record<ChatMediaKind, (p: string) => Promise<number | null>> = {
    voice: headChatAudioObject,
    video: headChatVideoObject,
    image: headChatImageObject,
    file: headChatFileObject,
  };
  const size = await headers[kind](storagePath);
  if (size === null) return { ok: false, reason: "not-uploaded" };

  const maxBytes: Record<ChatMediaKind, number> = {
    voice: MAX_AUDIO_BYTES,
    video: MAX_VIDEO_BYTES,
    image: MAX_IMAGE_BYTES,
    file: MAX_FILE_BYTES,
  };
  if (size > maxBytes[kind]) return { ok: false, reason: "too-large" };

  return { ok: true };
}
