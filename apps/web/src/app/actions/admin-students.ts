"use server";

import { issueMessage } from "@spiralclass/shared";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isBootstrapActor, requireAdmin } from "@/lib/admin";
import { writeOverride } from "@/lib/audit";
import { getPreferredLocale } from "@/lib/i18n";
import { adminSetStudentEmail } from "@/lib/students/email-change";
import { flushAnalytics } from "@/lib/analytics/posthog";
import { revalidateAfterAction } from "@/lib/revalidate";
import { createT } from "@spiralclass/shared";

export type AdminStudentActionState = { error?: string; ok?: boolean } | undefined;

const disableSchema = z.object({
  studentId: z.string().uuid("web.action.invalidId"),
  reason: z.string().trim().min(1, "Motivo requerido").max(280),
});

const enableSchema = z.object({
  studentId: z.string().uuid("web.action.invalidId"),
});

// Picks the teacher most recently linked to this student so the audit row
// has a sensible tenant scope. Students belong to many teachers, so we
// just take one for the override. Returns null when the student has no
// teachers (admin-created standalone student) — caller skips audit.
async function pickAuditScopeTeacher(studentId: string): Promise<string | null> {
  const link = await prisma.teacherStudent.findFirst({
    where: { studentId },
    orderBy: { createdAt: "desc" },
    select: { teacherId: true },
  });
  return link?.teacherId ?? null;
}

export async function disableStudentAction(
  _prev: AdminStudentActionState,
  formData: FormData,
): Promise<AdminStudentActionState> {
  const actor = await requireAdmin("support");
  const locale = await getPreferredLocale();
  const t = createT(locale);
  const parsed = disableSchema.safeParse({
    studentId: formData.get("studentId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      error: issueMessage(parsed.error, t, "web.action.invalidData"),
    };
  }

  const auditTeacherId = await pickAuditScopeTeacher(parsed.data.studentId);

  await prisma.$transaction(async (tx) => {
    const before = await tx.student.findUnique({
      where: { id: parsed.data.studentId },
      select: { disabledAt: true },
    });
    await tx.student.update({
      where: { id: parsed.data.studentId },
      data: { disabledAt: new Date(), disabledReason: parsed.data.reason },
    });
    if (auditTeacherId) {
      await writeOverride({
        tx,
        teacherId: auditTeacherId,
        targetType: "student",
        targetId: parsed.data.studentId,
        action: "disable_student",
        reason: parsed.data.reason,
        before: { disabledAt: before?.disabledAt?.toISOString() ?? null },
        after: { disabledAt: new Date().toISOString() },
        actor,
      });
    }
  });

  revalidateAfterAction(`/admin/students/${parsed.data.studentId}`);
  return { ok: true };
}

const changeEmailSchema = z.object({
  studentId: z.string().uuid("web.action.invalidId"),
  newEmail: z.string().trim().email("email.invalid").max(254),
});

// Support escape hatch for the verified email-change flow: the student lost
// access to their old inbox (and possibly their session), the operator
// verified their identity out-of-band, and we move the auth identity and
// the Student row(s) together. Audited in student_contact_changes with the
// acting admin. See src/lib/students/email-change.ts.
export async function adminChangeStudentEmailAction(
  _prev: AdminStudentActionState,
  formData: FormData,
): Promise<AdminStudentActionState> {
  const actor = await requireAdmin("support");
  const locale = await getPreferredLocale();
  const t = createT(locale);
  const parsed = changeEmailSchema.safeParse({
    studentId: formData.get("studentId"),
    newEmail: formData.get("newEmail"),
  });
  if (!parsed.success) {
    return {
      error: issueMessage(parsed.error, t, "web.action.invalidData"),
    };
  }

  const result = await adminSetStudentEmail({
    studentId: parsed.data.studentId,
    newEmail: parsed.data.newEmail,
    // Bootstrap superadmins have no admin_users row — the audit FK stays
    // NULL, same convention as writeOverride.
    actorAdminId: isBootstrapActor(actor) ? null : actor.id,
  });
  if (!result.ok) {
    switch (result.error) {
      case "not-found":
        return { error: t("web.action.admin.studentNotFound") };
      case "email-taken":
        return {
          error: t("web.action.admin.students.emailTakenOnRoster"),
        };
      case "unavailable":
        return {
          error: t("web.action.admin.students.emailUnusable"),
        };
    }
  }

  // Drain student_contact_updated (emitted by adminSetStudentEmail) before
  // the action returns / lambda freezes.
  await flushAnalytics();

  revalidateAfterAction(`/admin/students/${parsed.data.studentId}`);
  return { ok: true };
}

export async function enableStudentAction(
  _prev: AdminStudentActionState,
  formData: FormData,
): Promise<AdminStudentActionState> {
  const actor = await requireAdmin("support");
  const locale = await getPreferredLocale();
  const t = createT(locale);
  const parsed = enableSchema.safeParse({
    studentId: formData.get("studentId"),
  });
  if (!parsed.success) {
    return {
      error: issueMessage(parsed.error, t, "web.action.invalidData"),
    };
  }

  const auditTeacherId = await pickAuditScopeTeacher(parsed.data.studentId);

  await prisma.$transaction(async (tx) => {
    const before = await tx.student.findUnique({
      where: { id: parsed.data.studentId },
      select: { disabledAt: true, disabledReason: true },
    });
    await tx.student.update({
      where: { id: parsed.data.studentId },
      data: { disabledAt: null, disabledReason: null },
    });
    if (auditTeacherId) {
      await writeOverride({
        tx,
        teacherId: auditTeacherId,
        targetType: "student",
        targetId: parsed.data.studentId,
        action: "enable_student",
        reason: before?.disabledReason ?? "(no previous reason)",
        before: { disabledAt: before?.disabledAt?.toISOString() ?? null },
        after: { disabledAt: null },
        actor,
      });
    }
  });

  revalidateAfterAction(`/admin/students/${parsed.data.studentId}`);
  return { ok: true };
}
