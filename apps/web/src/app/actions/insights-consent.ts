"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import { setInsightsConsentFor } from "@/lib/lesson-notes/student-prefs";

// Lesson-insights consent gate (D-22). Web wrapper around the shared core
// (lib/lesson-notes/student-prefs.ts), which owns the consent-timestamp rule
// (which field counts for a minor); here we add auth + Pro-gating + locale
// messages + revalidation. Recording the
// timestamp is what flips `lessonInsightsConsentOk`.

export type ConsentState = { ok?: boolean; error?: string };

export async function setInsightsConsent(
  studentId: string,
  input: { isMinor: boolean; consented: boolean },
): Promise<ConsentState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  const gate = await gateProFeature(teacher.id, "lesson_notes");
  if (!gate.ok) return { error: upgradeNudge(gate.limit, locale) };

  const res = await setInsightsConsentFor(prisma, teacher.id, studentId, input);
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
