import { NextResponse } from "next/server";
import { getCurrentStudent } from "@/lib/auth";
import { studentChatThreads } from "@/lib/chat/threads";
import { studentIdentityIds } from "@/lib/students/identity";

export async function GET(): Promise<Response> {
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  return NextResponse.json(await studentChatThreads(await studentIdentityIds(student)));
}
