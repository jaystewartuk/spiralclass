"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { STUDENT_PROFILE_MAX_CHARS, type StudentProfileState } from "@/lib/student-profile-fields";
import { revalidateAfterAction } from "@/lib/revalidate";

// Durable student profile — interests + goals (docs/product/roadmap/
// CLASS_CONTENT_INPUTS.md, D-20, Layer 1).
//
// These live on teacher_students (the student's profile WITH THIS TEACHER) and
// are fed into every AI class-content generation. They are teacher-private,
// like StudentNote and custom_price_note: NOT written to the overrides
// table (which surfaces to the student) and excluded from the student data
// export. Every read/write scopes on teacher_id (tenant isolation).

// `STUDENT_PROFILE_MAX_CHARS` + `StudentProfileState` now live in
// `@/lib/student-profile-fields` — a `"use server"` file may only export async
// functions, so the value/type exports had to move out (imported just above).

const field = z
  .string()
  .trim()
  .max(STUDENT_PROFILE_MAX_CHARS)
  .transform((v) => (v === "" ? null : v));

const schema = z.object({
  studentId: z.string().uuid(),
  interests: field,
  goals: field,
});

export async function setStudentProfile(
  _prev: StudentProfileState,
  formData: FormData,
): Promise<StudentProfileState> {
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = schema.safeParse({
    studentId: formData.get("studentId"),
    interests: formData.get("interests") ?? "",
    goals: formData.get("goals") ?? "",
  });
  if (!parsed.success) {
    return {
      error: en
        ? `Keep each field under ${STUDENT_PROFILE_MAX_CHARS} characters.`
        : `Mantén cada campo por debajo de ${STUDENT_PROFILE_MAX_CHARS} caracteres.`,
    };
  }

  const teacher = await requireOnboardedTeacher();
  const { studentId, interests, goals } = parsed.data;

  const link = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: teacher.id, studentId } },
    select: { studentId: true },
  });
  if (!link) {
    return { error: en ? "This student isn't in your list." : "Este alumno no está en tu lista." };
  }

  await prisma.teacherStudent.update({
    where: { teacherId_studentId: { teacherId: teacher.id, studentId } },
    data: { interests, goals },
  });

  trackServerEvent({
    name: "student_profile_set",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      studentId,
      hasInterests: Boolean(interests),
      hasGoals: Boolean(goals),
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/students/${studentId}`);
  return { ok: en ? "Profile saved." : "Perfil guardado." };
}
