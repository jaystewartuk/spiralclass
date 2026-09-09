import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentStudent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { studentIdentityIds } from "@/lib/students/identity";
import { deleteChatMessage, editChatMessage } from "@/lib/chat/message-actions";
import { toChatWireMessage } from "@/lib/chat/wire";

// Edit (PATCH) / delete-for-everyone (DELETE) a single message the student
// sent. Mirrors the teacher-side route; identity resolution matches the other
// student chat routes (one auth user may map to several Student rows).

const patchSchema = z.object({ body: z.string().trim().min(1).max(4000) });

type Params = { params: Promise<{ teacherId: string; messageId: string }> };

async function resolveThread(student: Parameters<typeof studentIdentityIds>[0], teacherId: string) {
  const studentIds = await studentIdentityIds(student);
  return prisma.teacherStudent.findFirst({
    where: { teacherId, studentId: { in: studentIds } },
  });
}

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  const { teacherId, messageId } = await params;
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  const ts = await resolveThread(student, teacherId);
  if (!ts) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  let body: string;
  try {
    body = patchSchema.parse(await req.json()).body;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid-body" }, { status: 400 });
  }

  const result = await editChatMessage({
    teacherId,
    studentId: ts.studentId,
    messageId,
    senderRole: "student",
    body,
  });
  if (!result.ok)
    return NextResponse.json({ ok: false, reason: result.reason }, { status: result.status });
  return NextResponse.json(await toChatWireMessage(result.message));
}

export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  const { teacherId, messageId } = await params;
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  const ts = await resolveThread(student, teacherId);
  if (!ts) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  const result = await deleteChatMessage({
    teacherId,
    studentId: ts.studentId,
    messageId,
    senderRole: "student",
  });
  if (!result.ok)
    return NextResponse.json({ ok: false, reason: result.reason }, { status: result.status });
  return NextResponse.json(await toChatWireMessage(result.message));
}
