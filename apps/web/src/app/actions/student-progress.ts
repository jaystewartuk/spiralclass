"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import { setShareProgressFor } from "@/lib/lesson-notes/student-prefs";

// Phase F, Half 2. The teacher opts
// a student in (or out) of seeing their own learning profile. Wrapper around
// the shared core (lib/lesson-notes/student-prefs.ts); here we add auth +
// Pro-gating + locale messages + revalidation.

export type ShareState = { ok?: boolean; error?: string };

export async function setShareProgress(studentId: string, share: boolean): Promise<ShareState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  const gate = await gateProFeature(teacher.id, "lesson_notes");
  if (!gate.ok) return { error: upgradeNudge(gate.limit, locale) };

  const res = await setShareProgressFor(prisma, teacher.id, studentId, share);
  if (!res.ok) {
    return {
      error:
        res.reason === "not-found"
          ? en
            ? "Student not found."
            : "Alumno no encontrado."
          : en
            ? "Couldn't save. Please try again."
            : "No se pudo guardar. Inténtalo de nuevo.",
    };
  }

  revalidatePath(`/dashboard/students/${studentId}`);
  return { ok: true };
}
