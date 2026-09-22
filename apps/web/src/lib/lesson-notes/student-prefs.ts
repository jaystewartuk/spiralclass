import type { PrismaClient } from "@prisma/client";

import { logger } from "@/lib/logger";

const log = logger({ surface: "student-prefs" });

export type PrefResult = { ok: true } | { ok: false; reason: "not-found" | "save-failed" };

// Core for the two per-student lesson-insights prefs — the D-22 consent gate
// and the F2 share toggle. The consent timestamp rule (which field counts for a
// minor) lives here once so it can't drift. Callers own auth + Pro-gating +
// revalidation.

// Record (or revoke) the per-student insights consent (D-22). For a minor it's
// the guardian timestamp that counts; clearing the other keeps the gate
// deterministic. Recording the timestamp is what flips lessonInsightsConsentOk.
export async function setInsightsConsentFor(
  prisma: PrismaClient,
  teacherId: string,
  studentId: string,
  input: { isMinor: boolean; consented: boolean },
): Promise<PrefResult> {
  const now = new Date();
  const data = input.consented
    ? {
        isMinor: input.isMinor,
        insightsConsentAt: input.isMinor ? null : now,
        guardianConsentAt: input.isMinor ? now : null,
      }
    : { isMinor: input.isMinor, insightsConsentAt: null, guardianConsentAt: null };

  try {
    const updated = await prisma.teacherStudent.updateMany({
      where: { teacherId, studentId },
      data,
    });
    if (updated.count === 0) return { ok: false, reason: "not-found" };
  } catch (err) {
    log.error("set insights-consent failed", err, { studentId });
    return { ok: false, reason: "save-failed" };
  }
  return { ok: true };
}

// Share (or unshare) the student's learning profile with them (F2). Off by
// default; the teacher owns the framing, so sharing is deliberate.
export async function setShareProgressFor(
  prisma: PrismaClient,
  teacherId: string,
  studentId: string,
  share: boolean,
): Promise<PrefResult> {
  try {
    const updated = await prisma.teacherStudent.updateMany({
      where: { teacherId, studentId },
      data: { shareProgress: share },
    });
    if (updated.count === 0) return { ok: false, reason: "not-found" };
  } catch (err) {
    log.error("set share-progress failed", err, { studentId });
    return { ok: false, reason: "save-failed" };
  }
  return { ok: true };
}
