// Server-side edit & delete for chat messages, shared by all four route
// families (web/mobile × teacher/student). Routes do auth + tenancy and pass
// the resolved (teacherId, studentId) pair here; this module owns the
// WhatsApp-parity rules so they can't drift between surfaces:
//
//   - only the sender may edit or delete their own message
//   - edit is text-only (media = delete and re-record, as in WhatsApp) and
//     allowed for 15 minutes after send
//   - delete-for-everyone works for any type for ~2.5 days and leaves a
//     tombstone: the row survives (both sides render "message deleted" in
//     place) but body + media columns are nulled and the R2 object removed,
//     so the content itself is gone.

import { CHAT_DELETE_WINDOW_MS, CHAT_EDIT_WINDOW_MS } from "@spiralclass/shared";
import type { Message } from "@prisma/client";

import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { deleteChatAudioObject } from "@/lib/storage/chat-audio";
import { deleteChatVideoObject } from "@/lib/storage/chat-video";

const log = logger({ surface: "chat-message-actions" });

export type ChatActionFailure = {
  ok: false;
  status: 403 | 404 | 409;
  reason:
    "not-found" | "not-sender" | "not-editable" | "edit-window-expired" | "delete-window-expired";
};
export type ChatActionResult = { ok: true; message: Message } | ChatActionFailure;

export type ReactionActionFailure = {
  ok: false;
  status: 400 | 404;
  reason: "not-found" | "deleted" | "bad-emoji";
};
export type ReactionActionResult = { ok: true; message: Message } | ReactionActionFailure;

type ThreadScope = {
  teacherId: string;
  studentId: string;
  messageId: string;
  /** The authenticated caller's side of the thread. */
  senderRole: "teacher" | "student";
  now?: Date;
};

const CHAT_TEMPLATES = ["chat_message", "chat_message_teacher"];

// The chat notification row stores the message's first 100 chars as
// metadata.preview, and the in-app inbox re-renders from it forever — so an
// edit must refresh it and a delete must retract the row entirely, or the
// retracted/stale content outlives the message (the delayed-email fallback in
// dispatcher.ts double-checks metadata.messageId as a race/legacy backstop).
// Both are best-effort: the message row is already the source of truth.
async function refreshChatNotificationPreview(
  teacherId: string,
  messageId: string,
  body: string,
): Promise<void> {
  try {
    const rows = await prisma.notification.findMany({
      where: {
        teacherId,
        templateName: { in: CHAT_TEMPLATES },
        metadata: { path: ["messageId"], equals: messageId },
      },
      select: { id: true, metadata: true },
    });
    for (const row of rows) {
      const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
      await prisma.notification.update({
        where: { id: row.id },
        data: { metadata: { ...(meta as Record<string, unknown>), preview: body.slice(0, 100) } },
      });
    }
  } catch (err) {
    log.warn("chat notification preview refresh failed", {
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function retractChatNotifications(teacherId: string, messageId: string): Promise<void> {
  try {
    await prisma.notification.deleteMany({
      where: {
        teacherId,
        templateName: { in: CHAT_TEMPLATES },
        metadata: { path: ["messageId"], equals: messageId },
      },
    });
  } catch (err) {
    log.warn("chat notification retraction failed", {
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function editChatMessage(
  scope: ThreadScope & { body: string },
): Promise<ChatActionResult> {
  const now = scope.now ?? new Date();
  const message = await prisma.message.findFirst({
    where: { id: scope.messageId, teacherId: scope.teacherId, studentId: scope.studentId },
  });
  if (!message) return { ok: false, status: 404, reason: "not-found" };
  if (message.senderRole !== scope.senderRole)
    return { ok: false, status: 403, reason: "not-sender" };
  if (message.deletedAt || message.voiceStoragePath || message.videoStoragePath)
    return { ok: false, status: 409, reason: "not-editable" };
  if (now.getTime() - message.createdAt.getTime() > CHAT_EDIT_WINDOW_MS)
    return { ok: false, status: 403, reason: "edit-window-expired" };

  // WhatsApp doesn't badge a no-op edit; neither do we.
  if (message.body === scope.body) return { ok: true, message };

  // Conditional write: an edit must never land on a row that a concurrent
  // delete-for-everyone tombstoned between our read and this write.
  const res = await prisma.message.updateMany({
    where: { id: message.id, deletedAt: null },
    data: { body: scope.body, editedAt: now },
  });
  if (res.count === 0) return { ok: false, status: 409, reason: "not-editable" };
  // The row is already known-authorized (the findFirst above) and the write
  // we just made is the only one that could have landed (count === 1) — apply
  // the same change locally instead of a second round-trip to re-read it.
  const updated: Message = { ...message, body: scope.body, editedAt: now };

  await refreshChatNotificationPreview(scope.teacherId, message.id, scope.body);
  return { ok: true, message: updated };
}

export async function deleteChatMessage(scope: ThreadScope): Promise<ChatActionResult> {
  const now = scope.now ?? new Date();
  const message = await prisma.message.findFirst({
    where: { id: scope.messageId, teacherId: scope.teacherId, studentId: scope.studentId },
  });
  if (!message) return { ok: false, status: 404, reason: "not-found" };
  if (message.senderRole !== scope.senderRole)
    return { ok: false, status: 403, reason: "not-sender" };
  // Idempotent: re-deleting (e.g. a retried request) returns the tombstone.
  if (message.deletedAt) return { ok: true, message };
  if (now.getTime() - message.createdAt.getTime() > CHAT_DELETE_WINDOW_MS)
    return { ok: false, status: 403, reason: "delete-window-expired" };

  // Best-effort media cleanup BEFORE nulling the paths — a failure is logged
  // (with the path, so the orphan can be swept by hand) and the delete
  // proceeds: an orphaned object is harmless, a tombstone that still points
  // at live media is not.
  if (message.voiceStoragePath) {
    const removed = await deleteChatAudioObject(message.voiceStoragePath);
    if (!removed)
      log.warn("voice object cleanup failed", {
        messageId: message.id,
        storagePath: message.voiceStoragePath,
      });
  }
  if (message.videoStoragePath) {
    const removed = await deleteChatVideoObject(message.videoStoragePath);
    if (!removed)
      log.warn("video object cleanup failed", {
        messageId: message.id,
        storagePath: message.videoStoragePath,
      });
  }

  // Conditional write, mirroring editChatMessage: a concurrent delete already
  // tombstoned it → count 0, fall through and return the row as-is (idempotent).
  await prisma.message.updateMany({
    where: { id: message.id, deletedAt: null },
    data: {
      deletedAt: now,
      body: null,
      voiceStoragePath: null,
      voiceDurationMs: null,
      videoStoragePath: null,
      videoDurationMs: null,
    },
  });
  // The row is already known-authorized (the findFirst above) — apply the
  // same tombstone locally instead of a second round-trip to re-read it. A
  // concurrent delete winning the race in the tiny window above still leaves
  // the row tombstoned either way, so this stays idempotent.
  const updated: Message = {
    ...message,
    deletedAt: now,
    body: null,
    voiceStoragePath: null,
    voiceDurationMs: null,
    videoStoragePath: null,
    videoDurationMs: null,
  };

  await retractChatNotifications(scope.teacherId, message.id);
  return { ok: true, message: updated };
}

// A reasonable upper bound for a single emoji grapheme, generous enough for
// multi-codepoint sequences (ZWJ family emoji, skin-tone modifiers, VS16)
// without accepting arbitrary text as a "reaction".
const MAX_EMOJI_LENGTH = 8;

// Toggle the caller's reaction on a message, WhatsApp-style: either thread
// participant may react to any non-deleted message (not sender-restricted,
// unlike edit/delete), one reaction per person — sending the same emoji again
// removes it, a different emoji replaces it. No time window.
export async function toggleMessageReaction(
  scope: Omit<ThreadScope, "senderRole"> & { reactorRole: "teacher" | "student"; emoji: string },
): Promise<ReactionActionResult> {
  if (!scope.emoji || scope.emoji.length > MAX_EMOJI_LENGTH)
    return { ok: false, status: 400, reason: "bad-emoji" };

  const message = await prisma.message.findFirst({
    where: { id: scope.messageId, teacherId: scope.teacherId, studentId: scope.studentId },
  });
  if (!message) return { ok: false, status: 404, reason: "not-found" };
  if (message.deletedAt) return { ok: false, status: 400, reason: "deleted" };

  const existing = await prisma.messageReaction.findUnique({
    where: { messageId_reactorRole: { messageId: message.id, reactorRole: scope.reactorRole } },
  });

  if (existing?.emoji === scope.emoji) {
    await prisma.messageReaction.delete({ where: { id: existing.id } });
  } else if (existing) {
    await prisma.messageReaction.update({
      where: { id: existing.id },
      data: { emoji: scope.emoji },
    });
  } else {
    await prisma.messageReaction.create({
      data: { messageId: message.id, reactorRole: scope.reactorRole, emoji: scope.emoji },
    });
  }

  return { ok: true, message };
}
