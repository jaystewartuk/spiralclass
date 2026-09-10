"use server";

import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher, requireStudent } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import {
  setCaptionsConsentForStudent,
  setCaptionsGuardianConsentFor,
} from "@/lib/captions/consent-writes";
import { revalidateAfterAction } from "@/lib/revalidate";

// Live-captions consent gate (the captions architecture review
// P0). Two independent actions, mirroring the two people who can give this
// consent — see lib/captions/consent-writes.ts for why they're separate
// functions rather than one toggle branching on isMinor like the older
// lesson-insights consent.

export type ConsentState = { ok?: boolean; error?: string };

// Teacher-attested guardian consent for a minor. Web wrapper around the
// shared core, mirroring setInsightsConsent's shape (auth + Pro-gating +
// locale messages + revalidation) — captions ride the same lesson_notes
// entitlement as insights.
export async function setCaptionsGuardianConsent(
  studentId: string,
  input: { isMinor: boolean; consented: boolean },
): Promise<ConsentState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  const gate = await gateProFeature(teacher.id, "lesson_notes");
  if (!gate.ok) return { error: upgradeNudge(gate.limit, locale) };

  const res = await setCaptionsGuardianConsentFor(prisma, teacher.id, studentId, input);
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

  revalidateAfterAction(`/dashboard/students/${studentId}`);
  return { ok: true };
}

// The student's own self-service consent (adult path) — no Pro gate: this is
// the student expressing consent about her own voice, independent of
// whether any particular teacher currently has a Pro plan. Applies across
// her whole identity set (see setCaptionsConsentForStudent).
export async function setCaptionsConsent(consented: boolean): Promise<ConsentState> {
  const student = await requireStudent();

  const res = await setCaptionsConsentForStudent(prisma, student, consented);
  if (!res.ok) {
    const locale = await getPreferredLocale();
    return {
      error:
        locale === "en"
          ? "Couldn't save. Please try again."
          : "No se pudo guardar. Inténtalo de nuevo.",
    };
  }

  revalidateAfterAction("/my-classes/account");
  return { ok: true };
}
