import { NextResponse } from "next/server";
import { getCurrentTeacher } from "@/lib/auth";
import { teacherChatThreads } from "@/lib/chat/threads";

export async function GET(): Promise<Response> {
  const teacher = await getCurrentTeacher();
  if (!teacher) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  if (!teacher.onboardingCompleteAt)
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  return NextResponse.json(await teacherChatThreads(teacher.id));
}
