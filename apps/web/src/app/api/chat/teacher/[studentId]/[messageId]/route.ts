import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deleteChatMessage, editChatMessage } from "@/lib/chat/message-actions";
import { toChatWireMessage } from "@/lib/chat/wire";

// Edit (PATCH) / delete-for-everyone (DELETE) a single message the teacher
// sent. Window + sender rules live in lib/chat/message-actions.ts; this route
// only does auth + tenancy. Static siblings (voice/, video/) win over this
// dynamic segment, and message ids are cuids so they can never collide.

const patchSchema = z.object({ body: z.string().trim().min(1).max(4000) });

type Params = { params: Promise<{ studentId: string; messageId: string }> };

async function resolveThread(studentId: string, teacherId: string) {
  return prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId, studentId } },
  });
}

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  const teacher = await getCurrentTeacher();
  if (!teacher || !teacher.onboardingCompleteAt)
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const { studentId, messageId } = await params;
  const ts = await resolveThread(studentId, teacher.id);
  if (!ts) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  let body: string;
  try {
    body = patchSchema.parse(await req.json()).body;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid-body" }, { status: 400 });
  }

  const result = await editChatMessage({
    teacherId: teacher.id,
    studentId,
    messageId,
    senderRole: "teacher",
    body,
  });
  if (!result.ok)
    return NextResponse.json({ ok: false, reason: result.reason }, { status: result.status });
  return NextResponse.json(await toChatWireMessage(result.message));
}

export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  const teacher = await getCurrentTeacher();
  if (!teacher || !teacher.onboardingCompleteAt)
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const { studentId, messageId } = await params;
  const ts = await resolveThread(studentId, teacher.id);
  if (!ts) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  const result = await deleteChatMessage({
    teacherId: teacher.id,
    studentId,
    messageId,
    senderRole: "teacher",
  });
  if (!result.ok)
    return NextResponse.json({ ok: false, reason: result.reason }, { status: result.status });
  return NextResponse.json(await toChatWireMessage(result.message));
}
