"use server";

import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { requireStudent } from "@/lib/auth";
import { studentIdentityIds } from "@/lib/students/identity";
import { GRADES, type Grade } from "@/lib/lesson-notes/srs";
import { gradeVocabularyFor } from "@/lib/lesson-notes/student-progress";
import { revalidateAfterAction } from "@/lib/revalidate";

// Phase F, Half 2: a student grades a due vocabulary term; the SRS scheduler
// reschedules it. Wrapper around the shared core
// (lib/lesson-notes/student-progress.ts).
// App-scoped to the signed-in student's identity set, so a student can only touch
// their own review rows.

export type GradeState = { ok?: boolean; error?: string };

const gradeSchema = z.enum(GRADES);

export async function gradeVocabulary(reviewId: string, grade: Grade): Promise<GradeState> {
  const student = await requireStudent();
  const parsed = gradeSchema.safeParse(grade);
  if (!parsed.success) return { error: "invalid-grade" };

  const ids = await studentIdentityIds(student);
  const res = await gradeVocabularyFor(prisma, ids, reviewId, parsed.data);
  if (!res.ok) return { error: res.reason };

  revalidateAfterAction("/my-classes/progress");
  return { ok: true };
}
