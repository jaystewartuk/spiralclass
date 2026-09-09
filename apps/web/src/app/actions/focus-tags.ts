"use server";

import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import {
  saveFocusCategoriesForTeacher,
  saveFocusTagsForTeacher,
  type FocusTagCategoryRow,
  type FocusTagRow,
} from "@/lib/focus-tags";

// Teacher-editable focus tags + categories (D-20's deferred follow-up: "rename
// / add / reorder / archive"; category later moved from free text into
// its own manageable taxonomy). These are the WEB entry points — FormData
// parsing, then delegate the Pro gate + validation + writes to
// @/lib/focus-tags. That delegation existed so a second caller could share
// the exact same logic; it is gone and the split stays, because
// the gate and the validation are worth testing without a FormData around them.
//
// Replace-set convention, same as saveTemplatesAction: each form posts the
// teacher's whole current list (existing rows + any newly added), each
// flagged keep/not; array order becomes the new position.

export type SaveFocusTagsState = { error?: string; ok?: boolean; tags?: FocusTagRow[] } | undefined;

export async function saveFocusTagsAction(
  _prev: SaveFocusTagsState,
  formData: FormData,
): Promise<SaveFocusTagsState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();

  const ids = formData.getAll("tag_id") as string[];
  const labels = formData.getAll("tag_label") as string[];
  const categoryIds = formData.getAll("tag_category_id") as string[];
  const keeps = formData.getAll("tag_keep") as string[];

  const rows = labels.map((label, i) => ({
    id: ids[i] || undefined,
    label,
    categoryId: categoryIds[i] ?? "",
    keep: keeps[i] === "1",
  }));

  const result = await prisma.$transaction(
    (tx) => saveFocusTagsForTeacher({ teacherId: teacher.id, locale, rows }, tx),
    // A full replace-set save (a seeded pack can be 30+ rows) needs more than
    // Prisma's 5000ms interactive-transaction default — see the comment on
    // saveFocusTagsForTeacher's write loop.
    { timeout: 15000 },
  );
  if (!result.ok) return { error: result.message };
  return { ok: true, tags: result.tags };
}

export type SaveFocusCategoriesState =
  { error?: string; ok?: boolean; categories?: FocusTagCategoryRow[] } | undefined;

export async function saveFocusCategoriesAction(
  _prev: SaveFocusCategoriesState,
  formData: FormData,
): Promise<SaveFocusCategoriesState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();

  const ids = formData.getAll("category_id") as string[];
  const labels = formData.getAll("category_label") as string[];
  const keeps = formData.getAll("category_keep") as string[];

  const rows = labels.map((label, i) => ({
    id: ids[i] || undefined,
    label,
    keep: keeps[i] === "1",
  }));

  const result = await prisma.$transaction(
    (tx) => saveFocusCategoriesForTeacher({ teacherId: teacher.id, locale, rows }, tx),
    { timeout: 15000 },
  );
  if (!result.ok) return { error: result.message };
  return { ok: true, categories: result.categories };
}
