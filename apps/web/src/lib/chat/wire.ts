// Message row → ChatMessage wire mapping, shared by every chat surface (the
// chat routes and the two chat pages' initial server render) so a new wire
// field lands everywhere at once instead of in a dozen per-route copies.

import type {
  ChatMessage,
  ChatMessageReaction,
  ChatMessageReplyPreview,
} from "@spiralclass/shared";
import type { Message, MessageReaction } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { mintChatAudioSignedUrl } from "@/lib/storage/chat-audio";
import { mintChatVideoSignedUrl } from "@/lib/storage/chat-video";
import { mintChatImageSignedUrl } from "@/lib/storage/chat-image";
import { mintChatFileSignedUrl } from "@/lib/storage/chat-file";

// `reactions` is optional: callers that already have them loaded (e.g. a
// thread-list query with `include: { reactions: true }`) pass them straight
// through; a freshly created message can pass `[]`; anything else falls back
// to a lookup so no call site is forced to remember the relation.
type WireInput = Message & { reactions?: Pick<MessageReaction, "reactorRole" | "emoji">[] };

function messageKind(
  m: Pick<Message, "voiceDurationMs" | "videoDurationMs" | "imageStoragePath" | "fileStoragePath">,
): ChatMessageReplyPreview["kind"] {
  if (m.voiceDurationMs !== null) return "voice";
  if (m.videoDurationMs !== null) return "video";
  if (m.imageStoragePath !== null) return "image";
  if (m.fileStoragePath !== null) return "file";
  return "text";
}

export async function toChatWireMessage(m: WireInput): Promise<ChatMessage> {
  // A deleted message carries no attachment, whatever its row still holds.
  // deleteChatMessage clears the columns, but rows deleted before it cleared
  // image and file paths (#73) still have them, and this is the one place
  // every surface turns a path into a link.
  const live = !m.deletedAt;
  const voiceUrl =
    live && m.voiceStoragePath ? await mintChatAudioSignedUrl(m.voiceStoragePath) : null;
  const videoUrl =
    live && m.videoStoragePath ? await mintChatVideoSignedUrl(m.videoStoragePath) : null;
  const imageUrl =
    live && m.imageStoragePath ? await mintChatImageSignedUrl(m.imageStoragePath) : null;
  const fileUrl = live && m.fileStoragePath ? await mintChatFileSignedUrl(m.fileStoragePath) : null;
  const reactionRows =
    m.reactions ??
    (m.deletedAt
      ? []
      : await prisma.messageReaction.findMany({
          where: { messageId: m.id },
          select: { reactorRole: true, emoji: true },
        }));
  const reactions: ChatMessageReaction[] = reactionRows.map((r) => ({
    role: r.reactorRole as "teacher" | "student",
    emoji: r.emoji,
  }));
  let replyPreview: ChatMessageReplyPreview | null = null;
  if (m.replyToId) {
    const original = await prisma.message.findUnique({
      where: { id: m.replyToId },
      select: {
        id: true,
        senderRole: true,
        body: true,
        deletedAt: true,
        voiceDurationMs: true,
        videoDurationMs: true,
        imageStoragePath: true,
        fileStoragePath: true,
      },
    });
    if (original) {
      replyPreview = {
        id: original.id,
        body: original.deletedAt ? null : original.body,
        senderRole: original.senderRole as "teacher" | "student",
        kind: messageKind(original),
      };
    }
  }
  return {
    id: m.id,
    senderRole: m.senderRole as "teacher" | "student",
    body: m.body,
    replyToId: m.replyToId,
    replyPreview,
    voiceUrl,
    voiceDurationMs: m.voiceDurationMs,
    videoUrl,
    videoDurationMs: m.videoDurationMs,
    imageUrl,
    imageWidth: live ? m.imageWidth : null,
    imageHeight: live ? m.imageHeight : null,
    fileUrl,
    fileName: live ? m.fileName : null,
    fileSizeBytes: live ? m.fileSizeBytes : null,
    fileMimeType: live ? m.fileMimeType : null,
    createdAt: m.createdAt.toISOString(),
    readAt: m.readAt?.toISOString() ?? null,
    editedAt: m.editedAt?.toISOString() ?? null,
    deletedAt: m.deletedAt?.toISOString() ?? null,
    reactions,
  };
}
