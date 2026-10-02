"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { ensureTeacherLevels } from "@/lib/levels";
import { revalidateAfterAction } from "@/lib/revalidate";
import { createT } from "@spiralclass/shared";

// Level-gated material library — docs/features/library-materials.md.
//
// A student's level lives on `teacher_students` (their level WITH THIS
// teacher), so it stays correct under multi-teacher tenancy. Setting it drives
// which library items they can browse. All reads/writes scope on teacher_id
// (tenant isolation).

export type LevelFormState = { error?: string; ok?: string } | undefined;

// Empty string clears the level (back to "not set").
const setStudentLevelSchema = z.object({
  studentId: z.string().uuid(),
  levelId: z.union([z.string().uuid(), z.literal("")]),
});

export async function setStudentLevel(
  _prev: LevelFormState,
  formData: FormData,
): Promise<LevelFormState> {
  const locale = await getPreferredLocale();
  const t = createT(locale);
  const parsed = setStudentLevelSchema.safeParse({
    studentId: formData.get("studentId"),
    levelId: formData.get("levelId") ?? "",
  });
  if (!parsed.success) {
    return { error: t("web.action.invalidData") };
  }

  const teacher = await requireOnboardedTeacher();
  const { studentId, levelId } = parsed.data;

  const link = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: teacher.id, studentId } },
    select: { studentId: true },
  });
  if (!link) {
    return { error: t("web.action.studentNotInList") };
  }

  // A non-empty level must belong to THIS teacher — never trust the posted id.
  if (levelId) {
    const owned = await prisma.level.findFirst({
      where: { id: levelId, teacherId: teacher.id, archived: false },
      select: { id: true },
    });
    if (!owned) {
      return { error: t("web.action.levels.unknown") };
    }
  }

  await prisma.teacherStudent.update({
    where: { teacherId_studentId: { teacherId: teacher.id, studentId } },
    data: { levelId: levelId || null },
  });

  trackServerEvent({
    name: "student_level_set",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, studentId, levelId: levelId || null },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/students/${studentId}`);
  return { ok: t("web.action.levels.saved") };
}

// Convenience used by the student detail page to render the selector. Seeds
// CEFR on first use (self-healing).
export async function getMyLevels() {
  const teacher = await requireOnboardedTeacher();
  await ensureTeacherLevels(teacher.id);
  return prisma.level.findMany({
    where: { teacherId: teacher.id, archived: false },
    select: { id: true, code: true, label: true, position: true },
    orderBy: { position: "asc" },
  });
}
