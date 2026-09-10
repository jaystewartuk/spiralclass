"use server";

import { z } from "zod";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { mergeRosterStudents as mergeCore, type MergeRefusal } from "@/lib/students/merge";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import type { OverrideState } from "./overrides";
import { revalidateAfterAction } from "@/lib/revalidate";

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

function refusalCopy(code: MergeRefusal, en: boolean): string {
  switch (code) {
    case "not_on_roster":
      return en
        ? "Both students must be on your roster."
        : "Ambos alumnos deben estar en tu listado.";
    case "disabled":
      return en
        ? "One of these accounts is disabled — contact support to merge them."
        : "Una de estas cuentas está deshabilitada — escribe a soporte para combinarlas.";
    case "two_logins":
      return en
        ? "Both students have signed in with different accounts, so they may be different people. Contact support if you're sure they're the same."
        : "Ambos alumnos han iniciado sesión con cuentas distintas, así que podrían ser personas diferentes. Escribe a soporte si estás segura de que son la misma.";
    case "other_teacher":
      return en
        ? "The duplicate is also enrolled with another teacher — contact support to merge them."
        : "El duplicado también está inscrito con otra maestra — escribe a soporte para combinarlos.";
    case "pending_deletion":
      return en
        ? "The duplicate has a pending deletion request and can't be merged."
        : "El duplicado tiene una solicitud de eliminación pendiente y no se puede combinar.";
    case "failed":
      return en
        ? "The merge couldn't be completed. Nothing was changed — contact support."
        : "No se pudo completar la combinación. No se cambió nada — escribe a soporte.";
  }
}

export async function mergeRosterStudents(
  _prev: OverrideState,
  formData: FormData,
): Promise<OverrideState> {
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = mergeSchema.safeParse({
    keepStudentId: formData.get("keepStudentId"),
    mergeStudentId: formData.get("mergeStudentId"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data." : "Datos inválidos."),
    };
  }
  const { keepStudentId, mergeStudentId } = parsed.data;

  const teacher = await requireOnboardedTeacher();
  const result = await mergeCore({ teacherId: teacher.id, keepStudentId, mergeStudentId });
  if (!result.ok) return { error: refusalCopy(result.code, en) };

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
    ok: en
      ? "Students merged — packages and classes now live under one profile."
      : "Alumnos combinados — los paquetes y clases ahora viven en un solo perfil.",
  };
}
