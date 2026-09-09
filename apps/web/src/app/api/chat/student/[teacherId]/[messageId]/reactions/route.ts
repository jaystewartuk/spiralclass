import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { studentIdentityIds } from "@/lib/students/identity";
import { toggleMessageReaction } from "@/lib/chat/message-actions";
import { toChatWireMessage } from "@/lib/chat/wire";

// Toggle the student's reaction on a message. Mirrors the teacher-side route.

const postSchema = z.object({ emoji: z.string().min(1).max(8) });

export async function POST(
  req: Request,
  { params }: { params: Promise<{ teacherId: string; messageId: string }> },
): Promise<Response> {
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const { teacherId, messageId } = await params;
  const studentIds = await studentIdentityIds(student);
  const ts = await prisma.teacherStudent.findFirst({
    where: { teacherId, studentId: { in: studentIds } },
  });
  if (!ts) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  let emoji: string;
  try {
    emoji = postSchema.parse(await req.json()).emoji;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid-body" }, { status: 400 });
  }

  const result = await toggleMessageReaction({
    teacherId,
    studentId: ts.studentId,
    messageId,
    reactorRole: "student",
    emoji,
  });
  if (!result.ok)
    return NextResponse.json({ ok: false, reason: result.reason }, { status: result.status });
  return NextResponse.json(await toChatWireMessage(result.message));
}
