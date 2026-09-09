// WhatsApp-style edit & delete windows for chat messages, shared by the web
// and mobile UIs (to decide whether to offer the actions) and by the API
// routes (which enforce them server-side in lib/chat/message-actions.ts).
//
// Semantics mirror WhatsApp: only the sender may edit or delete; editing is
// text-only (voice notes and videos are delete-and-re-record, as in WhatsApp)
// within a 15-minute window; "delete for everyone" works for every message
// type within a ~2.5-day window and leaves a tombstone both sides can see.

import type { ChatMessage } from "./api";

export const CHAT_EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 min, WhatsApp's edit window
export const CHAT_DELETE_WINDOW_MS = 60 * 60 * 60 * 1000; // ~2.5 days, WhatsApp's delete-for-everyone window

type ActionableMessage = Pick<
  ChatMessage,
  | "senderRole"
  | "body"
  | "voiceDurationMs"
  | "videoDurationMs"
  | "imageUrl"
  | "fileUrl"
  | "createdAt"
  | "deletedAt"
>;

// Text-ness is derived from the duration/attachment fields, not voiceUrl/
// videoUrl: the signed URLs come back null when R2 is misconfigured, which
// must not make a voice note suddenly look editable. imageUrl/fileUrl are
// safe to check directly since (unlike voice/video) they carry no duration
// to key off instead.
function isTextMessage(m: ActionableMessage): boolean {
  return (
    m.body !== null &&
    m.voiceDurationMs === null &&
    m.videoDurationMs === null &&
    m.imageUrl === null &&
    m.fileUrl === null
  );
}

// WhatsApp's default quick-reaction row, shown above the full emoji picker in
// a message's context menu.
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

export function canEditChatMessage(
  m: ActionableMessage,
  myRole: "teacher" | "student",
  nowMs: number,
): boolean {
  return (
    m.senderRole === myRole &&
    m.deletedAt === null &&
    isTextMessage(m) &&
    nowMs - Date.parse(m.createdAt) <= CHAT_EDIT_WINDOW_MS
  );
}

export function canDeleteChatMessage(
  m: ActionableMessage,
  myRole: "teacher" | "student",
  nowMs: number,
): boolean {
  return (
    m.senderRole === myRole &&
    m.deletedAt === null &&
    nowMs - Date.parse(m.createdAt) <= CHAT_DELETE_WINDOW_MS
  );
}
