"use server";

import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import {
  deleteClassContentTemplate,
  saveClassContentTemplate,
  saveClassContentTemplatesForTeacher,
  type ClassContentTemplateRow,
} from "@/lib/materials/templates";

// Lesson templates (D-46) — Markdown skeletons a teacher reuses across
// materials, independent of any single material (D-69). Booking-scoped and
// library-scoped content authoring both live in app/actions/library.ts now
// (the unified material form, docs/features/library-materials.md); this file
// is templates only.

export type SaveTemplateState =
  { error?: string; ok?: boolean; template?: ClassContentTemplateRow } | undefined;

export async function saveClassContentTemplateAction(
  _prev: SaveTemplateState,
  formData: FormData,
): Promise<SaveTemplateState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();

  const result = await saveClassContentTemplate({
    teacherId: teacher.id,
    label: String(formData.get("label") ?? ""),
    body: String(formData.get("body") ?? ""),
    locale,
  });
  if (!result.ok) return { error: result.message };
  return { ok: true, template: result.template };
}

export async function deleteClassContentTemplateAction(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const templateId = String(formData.get("templateId") ?? "");
  await deleteClassContentTemplate({ teacherId: teacher.id, templateId });
}

// Full template manager — the replace-set save for the standalone
// /settings/class-content-templates page. Mirrors saveFocusTagsAction: the form
// posts the whole current list (existing + newly added), each flagged keep/not;
// array order becomes the new position. One transaction so a mid-save failure
// never leaves a partial reorder.
export type SaveTemplatesState =
  { error?: string; ok?: boolean; templates?: ClassContentTemplateRow[] } | undefined;

export async function saveClassContentTemplatesAction(
  _prev: SaveTemplatesState,
  formData: FormData,
): Promise<SaveTemplatesState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();

  const ids = formData.getAll("tpl_id") as string[];
  const labels = formData.getAll("tpl_label") as string[];
  const bodies = formData.getAll("tpl_body") as string[];
  const keeps = formData.getAll("tpl_keep") as string[];

  const rows = labels.map((label, i) => ({
    id: ids[i] || undefined,
    label,
    body: bodies[i] ?? "",
    keep: keeps[i] === "1",
  }));

  const result = await prisma.$transaction(
    (tx) => saveClassContentTemplatesForTeacher({ teacherId: teacher.id, locale, rows }, tx),
    { timeout: 15000 },
  );
  if (!result.ok) return { error: result.message };
  return { ok: true, templates: result.templates };
}
