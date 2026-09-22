import { NextResponse } from "next/server";
import { getCurrentStudent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { studentIdentityIds } from "@/lib/students/identity";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { enqueueChatMessageTeacher } from "@/lib/notifications/enqueue";
import { presignChatMedia, validateChatMediaUpload } from "@/lib/storage/chat-media";
import { toChatWireMessage } from "@/lib/chat/wire";
import { validateReplyToId } from "@/lib/chat/reply";
import { trackMessageSent } from "@/lib/chat/analytics";
import { flushAnalytics } from "@/lib/analytics/posthog";

// Document attachments upload direct-to-R2: mirrors the teacher-side route,
// plus persists the original file name. See lib/storage/chat-media.ts.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ teacherId: string }> },
): Promise<Response> {
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  const { teacherId } = await params;
  const studentIds = await studentIdentityIds(student);
  const ts = await prisma.teacherStudent.findFirst({
    where: { teacherId, studentId: { in: studentIds } },
  });
  if (!ts) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });
  const contentType = new URL(req.url).searchParams.get("contentType") ?? "";
  const presigned = presignChatMedia("file", teacherId, ts.studentId, contentType, Date.now());
  if ("error" in presigned)
    return NextResponse.json(
      { ok: false, reason: presigned.error },
      { status: presigned.error === "bad-type" ? 415 : 502 },
    );
  return NextResponse.json({ uploadUrl: presigned.uploadUrl, storagePath: presigned.storagePath });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ teacherId: string }> },
): Promise<Response> {
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const { teacherId } = await params;
  const studentIds = await studentIdentityIds(student);
  const ts = await prisma.teacherStudent.findFirst({
    where: { teacherId, studentId: { in: studentIds } },
  });
  if (!ts) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    storagePath?: unknown;
    fileName?: unknown;
    sizeBytes?: unknown;
    mimeType?: unknown;
    replyToId?: unknown;
  } | null;
  const storagePath = typeof body?.storagePath === "string" ? body.storagePath : "";
  const check = await validateChatMediaUpload("file", storagePath, teacherId, ts.studentId);
  if (!check.ok)
    return NextResponse.json(
      { ok: false, reason: check.reason },
      { status: check.reason === "too-large" ? 413 : 400 },
    );
  const replyCheck = await validateReplyToId(body?.replyToId, teacherId, ts.studentId);
  if (!replyCheck.ok)
    return NextResponse.json({ ok: false, reason: "invalid-reply-to" }, { status: 400 });
  const sizeBytes = Number(body?.sizeBytes);
  const fileName = typeof body?.fileName === "string" ? body.fileName.slice(0, 255) : null;
  const mimeType = typeof body?.mimeType === "string" ? body.mimeType.slice(0, 255) : null;

  const message = await prisma.message.create({
    data: {
      teacherId,
      studentId: ts.studentId,
      senderRole: "student",
      body: null,
      fileStoragePath: storagePath,
      fileName,
      fileSizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
      fileMimeType: mimeType,
      replyToId: replyCheck.replyToId,
    },
  });

  try {
    const notifId = await enqueueChatMessageTeacher(prisma, {
      teacherId,
      studentId: ts.studentId,
      preview: fileName ?? "Archivo",
      messageId: message.id,
    });
    await emitNotificationQueued({ notificationId: notifId, teacherId });
  } catch {
    // best-effort
  }

  trackMessageSent({
    teacherId,
    studentId: ts.studentId,
    senderRole: "student",
    hasAttachment: true,
  });
  await flushAnalytics();

  return NextResponse.json(await toChatWireMessage(message));
}
