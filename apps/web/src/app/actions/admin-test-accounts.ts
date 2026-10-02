"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { writeOverride } from "@/lib/audit";
import { getPreferredLocale } from "@/lib/i18n";
import { revalidateAfterAction } from "@/lib/revalidate";
import { createT } from "@spiralclass/shared";

/**
 * Mark a teacher or a student as an operator's test account, or unmark it
 * (D-192).
 *
 * The ONLY write path for `testAccount`: an admin, with a reason, audited in
 * the same transaction as the change. Read-side only — it never touches
 * sign-in, booking, payment or entitlements — so the flag cannot lock anyone
 * out or stop money; what it changes is which figures the account counts in.
 */

export type TestAccountActionState = { error?: string; ok?: boolean } | undefined;

const schema = z.object({
  target: z.enum(["teacher", "student"]),
  id: z.string().uuid(),
  testAccount: z.enum(["true", "false"]),
  reason: z.string().trim().min(1).max(280),
});

export async function setTestAccountAction(
  _prev: TestAccountActionState,
  formData: FormData,
): Promise<TestAccountActionState> {
  const actor = await requireAdmin("support");
  const t = createT(await getPreferredLocale());
  const parsed = schema.safeParse({
    target: formData.get("target"),
    id: formData.get("id"),
    testAccount: formData.get("testAccount"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { error: t("web.action.admin.reasonRequired") };
  }
  const { target, id, reason } = parsed.data;
  const value = parsed.data.testAccount === "true";

  const found = await prisma.$transaction(async (tx) => {
    const before =
      target === "teacher"
        ? await tx.teacher.findUnique({ where: { id }, select: { testAccount: true } })
        : await tx.student.findUnique({ where: { id }, select: { testAccount: true } });
    if (!before) return false;
    if (target === "teacher") {
      await tx.teacher.update({ where: { id }, data: { testAccount: value } });
    } else {
      await tx.student.update({ where: { id }, data: { testAccount: value } });
    }
    // A student is not one teacher's: the audit row is scoped to the teacher
    // most recently linked, or to none — the row is written either way.
    const scopeTeacherId =
      target === "teacher"
        ? id
        : ((
            await tx.teacherStudent.findFirst({
              where: { studentId: id },
              orderBy: { createdAt: "desc" },
              select: { teacherId: true },
            })
          )?.teacherId ?? null);
    await writeOverride({
      tx,
      teacherId: scopeTeacherId,
      targetType: target,
      targetId: id,
      action: value ? "mark_test_account" : "unmark_test_account",
      reason,
      before: { testAccount: before.testAccount },
      after: { testAccount: value },
      actor,
    });
    return true;
  });
  if (!found) return { error: t("web.action.admin.notFound") };

  revalidateAfterAction(`/admin/${target}s/${id}`);
  return { ok: true };
}
