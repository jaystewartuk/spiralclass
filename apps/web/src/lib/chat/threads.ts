// The thread-summary query: one row per conversation, carrying its newest
// message and the unread count against it.
//
// This existed as SIX near-identical copies of the same `$queryRaw` — three on
// the teacher side and three on the student side. (Two are gone; the
// drift they caused is why this file exists.) They had already drifted: two
// copies never selected `voice_storage_path` at all, so a voice note previewed
// as an empty string there while the others previewed it as "voice message";
// and every copy selected the voice path
// ONLY, so a photo, a video or a document also previewed as "voice message".
//
// One query per side now, and both select enough to name the attachment
// correctly (`lastMessageKind`) without minting a signed URL per row.

import { cache } from "react";
import type { ChatMessageKind, ChatThread, StudentChatThread } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";

/** The columns the LATERAL join brings back for the newest message in a thread. */
type LastMessageColumns = {
  last_id: string;
  last_sender_role: string;
  last_body: string | null;
  last_voice_storage_path: string | null;
  last_video_storage_path: string | null;
  last_image_storage_path: string | null;
  last_file_storage_path: string | null;
  last_file_name: string | null;
  last_created_at: Date;
  last_read_at: Date | null;
  last_edited_at: Date | null;
  last_deleted_at: Date | null;
  unread_count: bigint;
};

/**
 * A deleted message has its media columns nulled at delete time (the tombstone
 * keeps only the row), so a tombstone reports "text" and the caller renders
 * its own "this message was deleted" placeholder instead of a kind.
 */
function lastMessageKind(row: LastMessageColumns): ChatMessageKind {
  if (row.last_voice_storage_path) return "voice";
  if (row.last_video_storage_path) return "video";
  if (row.last_image_storage_path) return "image";
  if (row.last_file_storage_path) return "file";
  return "text";
}

/**
 * The summary's `lastMessage`, shaped as a `ChatMessage` so the wire type is
 * one type rather than two.
 *
 * Every media URL is null on purpose: a thread list draws a one-line preview,
 * never the media itself, and signing N URLs to decide N pieces of one-line
 * copy would put a storage round trip per conversation in front of the list.
 * `lastMessageKind` beside it is what the preview reads instead.
 */
function toThreadLastMessage(row: LastMessageColumns): NonNullable<ChatThread["lastMessage"]> {
  return {
    id: row.last_id,
    senderRole: row.last_sender_role as "teacher" | "student",
    body: row.last_body,
    replyToId: null,
    replyPreview: null,
    voiceUrl: null,
    voiceDurationMs: null,
    videoUrl: null,
    videoDurationMs: null,
    imageUrl: null,
    imageWidth: null,
    imageHeight: null,
    fileUrl: null,
    fileName: row.last_file_name,
    fileSizeBytes: null,
    fileMimeType: null,
    createdAt: row.last_created_at.toISOString(),
    readAt: row.last_read_at?.toISOString() ?? null,
    editedAt: row.last_edited_at?.toISOString() ?? null,
    deletedAt: row.last_deleted_at?.toISOString() ?? null,
    reactions: [],
  };
}

/**
 * Every conversation this teacher has, newest activity first.
 *
 * Request-memoized: the inbox layout renders the rail from it and the inbox
 * page renders the phone-width list from the same data, and on one render pass
 * that must be one query rather than two.
 */
export const teacherChatThreads = cache(async function teacherChatThreads(
  teacherId: string,
): Promise<ChatThread[]> {
  const rows = await prisma.$queryRaw<
    (LastMessageColumns & { student_id: string; student_name: string })[]
  >`
    SELECT
      m.student_id,
      s.name                AS student_name,
      lm.id                 AS last_id,
      lm.sender_role        AS last_sender_role,
      lm.body               AS last_body,
      lm.voice_storage_path AS last_voice_storage_path,
      lm.video_storage_path AS last_video_storage_path,
      lm.image_storage_path AS last_image_storage_path,
      lm.file_storage_path  AS last_file_storage_path,
      lm.file_name          AS last_file_name,
      lm.created_at         AS last_created_at,
      lm.read_at            AS last_read_at,
      lm.edited_at          AS last_edited_at,
      lm.deleted_at         AS last_deleted_at,
      COUNT(*) FILTER (WHERE m.sender_role = 'student' AND m.read_at IS NULL) AS unread_count
    FROM messages m
    JOIN students s ON s.id = m.student_id
    JOIN LATERAL (
      SELECT id, sender_role, body, voice_storage_path, video_storage_path,
             image_storage_path, file_storage_path, file_name,
             created_at, read_at, edited_at, deleted_at
      FROM messages m2
      WHERE m2.teacher_id = m.teacher_id AND m2.student_id = m.student_id
      ORDER BY created_at DESC
      LIMIT 1
    ) lm ON true
    WHERE m.teacher_id = ${teacherId}::uuid
    GROUP BY m.student_id, s.name, lm.id, lm.sender_role, lm.body,
             lm.voice_storage_path, lm.video_storage_path, lm.image_storage_path,
             lm.file_storage_path, lm.file_name,
             lm.created_at, lm.read_at, lm.edited_at, lm.deleted_at
    ORDER BY lm.created_at DESC
  `;

  return rows.map((row) => ({
    studentId: row.student_id,
    studentName: row.student_name,
    lastMessage: toThreadLastMessage(row),
    lastMessageKind: lastMessageKind(row),
    unreadCount: Number(row.unread_count),
  }));
});

/**
 * Every conversation these student identity rows have, newest activity first.
 * A person can hold several `Student` rows (one per teacher who added them),
 * so the caller passes the whole identity set — see lib/students/identity.ts.
 */
export async function studentChatThreads(studentIds: string[]): Promise<StudentChatThread[]> {
  const rows = await prisma.$queryRaw<
    (LastMessageColumns & { teacher_id: string; teacher_name: string; student_id: string })[]
  >`
    SELECT
      m.teacher_id,
      t.name                AS teacher_name,
      m.student_id,
      lm.id                 AS last_id,
      lm.sender_role        AS last_sender_role,
      lm.body               AS last_body,
      lm.voice_storage_path AS last_voice_storage_path,
      lm.video_storage_path AS last_video_storage_path,
      lm.image_storage_path AS last_image_storage_path,
      lm.file_storage_path  AS last_file_storage_path,
      lm.file_name          AS last_file_name,
      lm.created_at         AS last_created_at,
      lm.read_at            AS last_read_at,
      lm.edited_at          AS last_edited_at,
      lm.deleted_at         AS last_deleted_at,
      COUNT(*) FILTER (WHERE m.sender_role = 'teacher' AND m.read_at IS NULL) AS unread_count
    FROM messages m
    JOIN teachers t ON t.id = m.teacher_id
    JOIN LATERAL (
      SELECT id, sender_role, body, voice_storage_path, video_storage_path,
             image_storage_path, file_storage_path, file_name,
             created_at, read_at, edited_at, deleted_at
      FROM messages m2
      WHERE m2.teacher_id = m.teacher_id AND m2.student_id = m.student_id
      ORDER BY created_at DESC
      LIMIT 1
    ) lm ON true
    WHERE m.student_id = ANY(${studentIds}::uuid[])
    GROUP BY m.teacher_id, t.name, m.student_id, lm.id, lm.sender_role, lm.body,
             lm.voice_storage_path, lm.video_storage_path, lm.image_storage_path,
             lm.file_storage_path, lm.file_name,
             lm.created_at, lm.read_at, lm.edited_at, lm.deleted_at
    ORDER BY lm.created_at DESC
  `;

  return rows.map((row) => ({
    teacherId: row.teacher_id,
    teacherName: row.teacher_name,
    studentId: row.student_id,
    lastMessage: toThreadLastMessage(row),
    lastMessageKind: lastMessageKind(row),
    unreadCount: Number(row.unread_count),
  }));
}
