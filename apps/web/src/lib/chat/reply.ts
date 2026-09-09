// Shared reply-to validation for every chat send route (text/voice/video/
// image/file, web + mobile, teacher + student): a client-supplied
// `replyToId` must point at a real message inside the SAME (teacherId,
// studentId) thread — otherwise a client could stitch a reply onto a
// message from an unrelated conversation it has no access to.

import { prisma } from "@/lib/prisma";

export type ReplyToValidation = { ok: true; replyToId: string | null } | { ok: false };

export async function validateReplyToId(
  replyToId: unknown,
  teacherId: string,
  studentId: string,
): Promise<ReplyToValidation> {
  if (replyToId === undefined || replyToId === null) return { ok: true, replyToId: null };
  if (typeof replyToId !== "string" || !replyToId) return { ok: false };

  const original = await prisma.message.findUnique({
    where: { id: replyToId },
    select: { teacherId: true, studentId: true },
  });
  if (!original || original.teacherId !== teacherId || original.studentId !== studentId) {
    return { ok: false };
  }
  return { ok: true, replyToId };
}
