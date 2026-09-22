import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentTeacher } from "@/lib/auth";
import { isSameOrigin } from "@/lib/auth/csrf";
import { prisma } from "@/lib/prisma";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { enqueueChatMessage } from "@/lib/notifications/enqueue";
import { toChatWireMessage } from "@/lib/chat/wire";
import { validateReplyToId } from "@/lib/chat/reply";
import { trackMessageSent } from "@/lib/chat/analytics";
import { flushAnalytics } from "@/lib/analytics/posthog";

const PAGE_SIZE = 50;

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

  const { searchParams } = new URL(req.url);
  const before = searchParams.get("before");

  const rows = await prisma.message.findMany({
    where: {
      teacherId: teacher.id,
      studentId,
      ...(before ? { createdAt: { lt: new Date(before) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE,
    include: { reactions: { select: { reactorRole: true, emoji: true } } },
  });

  // Mark-as-read is a state mutation living inside a GET. Under SameSite=Lax
  // the session cookie DOES ride a lured top-level cross-site navigation, so a
  // GET could be weaponised to silently mark a conversation read. Gate the
  // side effect on a same-origin signal (security audit L-2) — the read itself
  // stays available; only the mutation is suppressed cross-site.
  if (isSameOrigin(req)) {
    await prisma.message.updateMany({
      where: { teacherId: teacher.id, studentId, senderRole: "student", readAt: null },
      data: { readAt: new Date() },
    });
  }

  return NextResponse.json(await Promise.all(rows.reverse().map(toChatWireMessage)));
}

const postSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  replyToId: z.string().nullable().optional(),
});

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

  let body: string;
  let replyToId: string | null | undefined;
  try {
    const json = await req.json();
    const parsed = postSchema.parse(json);
    body = parsed.body;
    replyToId = parsed.replyToId;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid-body" }, { status: 400 });
  }

  const replyCheck = await validateReplyToId(replyToId, teacher.id, studentId);
  if (!replyCheck.ok)
    return NextResponse.json({ ok: false, reason: "invalid-reply-to" }, { status: 400 });

  const message = await prisma.message.create({
    data: {
      teacherId: teacher.id,
      studentId,
      senderRole: "teacher",
      body,
      replyToId: replyCheck.replyToId,
    },
  });

  try {
    const notifId = await enqueueChatMessage(prisma, {
      teacherId: teacher.id,
      studentId,
      preview: body.slice(0, 100),
      messageId: message.id,
    });
    await emitNotificationQueued({ notificationId: notifId, teacherId: teacher.id });
  } catch {
    // best-effort — don't fail the message send if notification enqueue fails
  }

  trackMessageSent({
    teacherId: teacher.id,
    studentId,
    senderRole: "teacher",
    hasAttachment: false,
  });
  await flushAnalytics();

  return NextResponse.json(await toChatWireMessage(message));
}
