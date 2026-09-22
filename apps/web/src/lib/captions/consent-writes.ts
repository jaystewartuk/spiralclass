import type { PrismaClient } from "@prisma/client";

import { logger } from "@/lib/logger";
import { studentIdentityIds } from "@/lib/students/identity";

const log = logger({ surface: "captions-consent" });

export type CaptionsConsentResult =
  { ok: true } | { ok: false; reason: "not-found" | "save-failed" };

// Teacher-attested guardian consent for a minor (mirrors setInsightsConsentFor's
// per-pairing shape, D-22) — only ever writes isMinor + captionsGuardianConsentAt.
// The adult self-consent field is a separate axis the teacher can never set on
// the student's behalf; see setCaptionsConsentForStudent below.
export async function setCaptionsGuardianConsentFor(
  prisma: PrismaClient,
  teacherId: string,
  studentId: string,
  input: { isMinor: boolean; consented: boolean },
): Promise<CaptionsConsentResult> {
  const data = {
    isMinor: input.isMinor,
    captionsGuardianConsentAt: input.consented && input.isMinor ? new Date() : null,
  };
  try {
    const updated = await prisma.teacherStudent.updateMany({
      where: { teacherId, studentId },
      data,
    });
    if (updated.count === 0) return { ok: false, reason: "not-found" };
  } catch (err) {
    log.error("set captions guardian-consent failed", err, { studentId });
    return { ok: false, reason: "save-failed" };
  }
  return { ok: true };
}

// The student's own self-service consent (adult path). Unlike nativeLanguage
// (which only ever touches the one linked Student row), this is a
// "sanctioned exception" in the same category as notification prefs (see
// lib/students/identity.ts's header comment): consent describes the PERSON
// giving it, not one specific teacher relationship, so toggling it applies
// across every current teacher pairing in her identity set at once, not just
// the pairing tied to whichever booking she happened to open the toggle
// from.
export async function setCaptionsConsentForStudent(
  prisma: PrismaClient,
  student: { id: string; email: string | null },
  consented: boolean,
): Promise<CaptionsConsentResult> {
  const identityIds = await studentIdentityIds(student, prisma);
  try {
    await prisma.teacherStudent.updateMany({
      where: { studentId: { in: identityIds } },
      data: { captionsConsentAt: consented ? new Date() : null },
    });
  } catch (err) {
    log.error("set captions self-consent failed", err, { studentId: student.id });
    return { ok: false, reason: "save-failed" };
  }
  return { ok: true };
}

// Current toggle state for display on the student's own account page/screen.
// "Any" rather than "every" pairing, so a student who already consented sees
// her toggle as ON even if a brand-new teacher pairing (created after she
// consented) hasn't been individually written yet — the enforcement gate
// (captionsPublishConsentOk in lib/captions/class-access.ts) still checks the
// SPECIFIC booking's own pairing, so a fresh pairing is never captioned
// without its own recorded consent regardless of what this reader shows.
export async function getCaptionsConsentForStudent(
  prisma: PrismaClient,
  student: { id: string; email: string | null },
): Promise<boolean> {
  const identityIds = await studentIdentityIds(student, prisma);
  const consented = await prisma.teacherStudent.findFirst({
    where: { studentId: { in: identityIds }, captionsConsentAt: { not: null } },
    select: { teacherId: true },
  });
  return consented != null;
}
