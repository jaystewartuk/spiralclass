import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth";
import { isSameOrigin } from "@/lib/auth/csrf";
import { prisma } from "@/lib/prisma";
import { studentIdentityIds } from "@/lib/students/identity";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { enqueueChatMessageTeacher } from "@/lib/notifications/enqueue";
import { toChatWireMessage } from "@/lib/chat/wire";
import { validateReplyToId } from "@/lib/chat/reply";
import { trackMessageSent } from "@/lib/chat/analytics";
import { flushAnalytics } from "@/lib/analytics/posthog";

const PAGE_SIZE = 50;

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

  const { searchParams } = new URL(req.url);
  const before = searchParams.get("before");

  const rows = await prisma.message.findMany({
    where: {
      teacherId,
      studentId: ts.studentId,
      ...(before ? { createdAt: { lt: new Date(before) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE,
    include: { reactions: { select: { reactorRole: true, emoji: true } } },
  });

  // Mark-as-read is a state mutation inside a GET; under SameSite=Lax the
  // session cookie rides a lured cross-site top-level navigation, so gate the
  // side effect on a same-origin signal (security audit L-2). The read stays
  // available cross-site; only the mutation is suppressed.
  if (isSameOrigin(req)) {
    await prisma.message.updateMany({
      where: { teacherId, studentId: ts.studentId, senderRole: "teacher", readAt: null },
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

  const replyCheck = await validateReplyToId(replyToId, teacherId, ts.studentId);
  if (!replyCheck.ok)
    return NextResponse.json({ ok: false, reason: "invalid-reply-to" }, { status: 400 });

  const message = await prisma.message.create({
    data: {
      teacherId,
      studentId: ts.studentId,
      senderRole: "student",
      body,
      replyToId: replyCheck.replyToId,
    },
  });

  try {
    const notifId = await enqueueChatMessageTeacher(prisma, {
      teacherId,
      studentId: ts.studentId,
      preview: body.slice(0, 100),
      messageId: message.id,
    });
    await emitNotificationQueued({ notificationId: notifId, teacherId });
  } catch {
    // best-effort — don't fail the message send if notification enqueue fails
  }

  trackMessageSent({
    teacherId,
    studentId: ts.studentId,
    senderRole: "student",
    hasAttachment: false,
  });
  await flushAnalytics();

  return NextResponse.json(await toChatWireMessage(message));
}
