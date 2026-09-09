import { NextResponse } from "next/server";
import { getCurrentTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { enqueueChatMessage } from "@/lib/notifications/enqueue";
import { presignChatMedia, validateChatMediaUpload } from "@/lib/storage/chat-media";
import { toChatWireMessage } from "@/lib/chat/wire";
import { validateReplyToId } from "@/lib/chat/reply";
import { trackMessageSent } from "@/lib/chat/analytics";
import { flushAnalytics } from "@/lib/analytics/posthog";

// Voice notes upload direct-to-R2 (see lib/storage/chat-media.ts): GET presigns
// a PUT ticket, the browser uploads straight to R2, then POST finalizes.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ studentId: string }> },
): Promise<Response> {
  const teacher = await getCurrentTeacher();
  if (!teacher || !teacher.onboardingCompleteAt)
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  const { studentId } = await params;
  const ts = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: teacher.id, studentId } },
  });
  if (!ts) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });
  const contentType = new URL(req.url).searchParams.get("contentType") ?? "";
  const presigned = presignChatMedia("voice", teacher.id, studentId, contentType, Date.now());
  if ("error" in presigned)
    return NextResponse.json(
      { ok: false, reason: presigned.error },
      { status: presigned.error === "bad-type" ? 415 : 502 },
    );
  return NextResponse.json({ uploadUrl: presigned.uploadUrl, storagePath: presigned.storagePath });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ studentId: string }> },
): Promise<Response> {
  const teacher = await getCurrentTeacher();
  if (!teacher || !teacher.onboardingCompleteAt)
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const { studentId } = await params;
  const ts = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: teacher.id, studentId } },
  });
  if (!ts) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    storagePath?: unknown;
    durationMs?: unknown;
    replyToId?: unknown;
  } | null;
  const storagePath = typeof body?.storagePath === "string" ? body.storagePath : "";
  const check = await validateChatMediaUpload("voice", storagePath, teacher.id, studentId);
  if (!check.ok)
    return NextResponse.json(
      { ok: false, reason: check.reason },
      { status: check.reason === "too-large" ? 413 : 400 },
    );
  const replyCheck = await validateReplyToId(body?.replyToId, teacher.id, studentId);
  if (!replyCheck.ok)
    return NextResponse.json({ ok: false, reason: "invalid-reply-to" }, { status: 400 });
  const durationMs = Number(body?.durationMs);

  const message = await prisma.message.create({
    data: {
      teacherId: teacher.id,
      studentId,
      senderRole: "teacher",
      body: null,
      voiceStoragePath: storagePath,
      voiceDurationMs: Number.isFinite(durationMs) ? durationMs : null,
      replyToId: replyCheck.replyToId,
    },
  });

  try {
    const notifId = await enqueueChatMessage(prisma, {
      teacherId: teacher.id,
      studentId,
      preview: "Voice message",
      messageId: message.id,
    });
    await emitNotificationQueued({ notificationId: notifId, teacherId: teacher.id });
  } catch {
    // best-effort
  }

  trackMessageSent({
    teacherId: teacher.id,
    studentId,
    senderRole: "teacher",
    hasAttachment: true,
  });
  await flushAnalytics();

  return NextResponse.json(await toChatWireMessage(message));
}
