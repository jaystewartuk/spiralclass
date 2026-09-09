import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toggleMessageReaction } from "@/lib/chat/message-actions";
import { toChatWireMessage } from "@/lib/chat/wire";

// Toggle the teacher's reaction on a message (any message in the thread, not
// just their own — unlike edit/delete). Same emoji again removes it, a
// different emoji replaces it. See toggleMessageReaction for the rules.

const postSchema = z.object({ emoji: z.string().min(1).max(8) });

export async function POST(
  req: Request,
  { params }: { params: Promise<{ studentId: string; messageId: string }> },
): Promise<Response> {
  const teacher = await getCurrentTeacher();
  if (!teacher || !teacher.onboardingCompleteAt)
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const { studentId, messageId } = await params;
  const ts = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: teacher.id, studentId } },
  });
  if (!ts) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  let emoji: string;
  try {
    emoji = postSchema.parse(await req.json()).emoji;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid-body" }, { status: 400 });
  }

  const result = await toggleMessageReaction({
    teacherId: teacher.id,
    studentId,
    messageId,
    reactorRole: "teacher",
    emoji,
  });
  if (!result.ok)
    return NextResponse.json({ ok: false, reason: result.reason }, { status: result.status });
  return NextResponse.json(await toChatWireMessage(result.message));
}
