import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { allDisabledPrefs } from "@/lib/notifications/preferences";

export type NotificationToggleResult = { ok: true } | { ok: false; reason: "not-found" };

// Teacher-authorized on/off switch for a student's notification categories.
// Roster-imported students start fully silenced (§ allDisabledPrefs, so a
// bulk import never spams people who never opted in); this is how the
// teacher flips a specific student to live once she's ready to onboard them
// for real, without the student needing to sign in first. "Off" restores
// the exact CSV-import shape; "on" clears the column back to the product
// default (null = every category enabled).
export async function setStudentNotificationsEnabledAsTeacher(
  prisma: PrismaClient,
  teacherId: string,
  studentId: string,
  enabled: boolean,
): Promise<NotificationToggleResult> {
  const updated = await prisma.student.updateMany({
    where: { id: studentId, teacherStudents: { some: { teacherId } } },
    data: { notificationPrefs: enabled ? Prisma.DbNull : (allDisabledPrefs() as object) },
  });
  if (updated.count === 0) return { ok: false, reason: "not-found" };
  return { ok: true };
}
