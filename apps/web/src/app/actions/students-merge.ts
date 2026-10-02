"use server";

import { issueMessage } from "@spiralclass/shared";
import type { TFunction } from "@spiralclass/shared";
import { z } from "zod";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { mergeRosterStudents as mergeCore, type MergeRefusal } from "@/lib/students/merge";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import type { OverrideState } from "./overrides";
import { revalidateAfterAction } from "@/lib/revalidate";
import { createT } from "@spiralclass/shared";

// Teacher-facing duplicate merge (see lib/students/merge.ts for the rules
// and the full list of what moves). This wrapper owns auth, input parsing,
// localized error copy, analytics and cache revalidation.

const mergeSchema = z
  .object({
    keepStudentId: z.string().uuid(),
    mergeStudentId: z.string().uuid(),
  })
  .refine((v) => v.keepStudentId !== v.mergeStudentId, {
    message: "keep and merge must differ",
  });

function refusalCopy(code: MergeRefusal, t: TFunction): string {
  switch (code) {
    case "not_on_roster":
      return t("web.action.merge.bothOnRoster");
    case "disabled":
      return t("web.action.merge.accountDisabled");
    case "two_logins":
      return t("web.action.merge.differentAccounts");
    case "other_teacher":
      return t("web.action.merge.otherTeacher");
    case "pending_deletion":
      return t("web.action.merge.pendingDeletion");
    case "failed":
      return t("web.action.merge.failed");
  }
}

export async function mergeRosterStudents(
  _prev: OverrideState,
  formData: FormData,
): Promise<OverrideState> {
  const locale = await getPreferredLocale();
  const t = createT(locale);
  const parsed = mergeSchema.safeParse({
    keepStudentId: formData.get("keepStudentId"),
    mergeStudentId: formData.get("mergeStudentId"),
  });
  if (!parsed.success) {
    return {
      error: issueMessage(parsed.error, t, "web.action.invalidData"),
    };
  }
  const { keepStudentId, mergeStudentId } = parsed.data;

  const teacher = await requireOnboardedTeacher();
  const result = await mergeCore({ teacherId: teacher.id, keepStudentId, mergeStudentId });
  if (!result.ok) return { error: refusalCopy(result.code, t) };

  trackServerEvent({
    name: "override_applied",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      action: "merge_students",
      targetType: "student",
      targetId: keepStudentId,
    },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/students/${keepStudentId}`);
  return {
    ok: t("web.action.merge.done"),
  };
}
