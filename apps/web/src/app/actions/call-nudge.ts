"use server";

import { requireOnboardedTeacher, requireStudent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { studentIdentityIds } from "@/lib/students/identity";
import { nudgeCounterparty, type NudgeResult } from "@/lib/video/nudge";

// Web server-action wrappers around the shared in-class nudge core
// (lib/video/nudge.ts). The core owns presence, cooldown, localization and the
// direct push; here we only add auth + resolve the counterparty. Two entry
// points because auth is
// role-specific (a teacher session vs a student session); the <ClassCall>
// waiting-room button is handed the one matching whose call surface it is.

export async function nudgeFromTeacher(bookingId: string): Promise<NudgeResult> {
  const teacher = await requireOnboardedTeacher();
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, teacherId: teacher.id },
    select: { id: true, studentId: true },
  });
  if (!booking) return { ok: false, reason: "not-found" };
  return nudgeCounterparty(prisma, {
    bookingId: booking.id,
    callerIdentity: teacher.id,
    callerName: teacher.name,
    to: { type: "student", id: booking.studentId },
  });
}

export async function nudgeFromStudent(bookingId: string): Promise<NudgeResult> {
  const student = await requireStudent();
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, studentId: { in: await studentIdentityIds(student) } },
    select: { id: true, teacherId: true },
  });
  if (!booking) return { ok: false, reason: "not-found" };
  return nudgeCounterparty(prisma, {
    bookingId: booking.id,
    callerIdentity: student.id,
    callerName: student.name,
    to: { type: "teacher", id: booking.teacherId },
  });
}
