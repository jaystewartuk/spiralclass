"use server";

import type { TFunction } from "@spiralclass/shared";
import { z } from "zod";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import {
  addShareGroup as addShareGroupCore,
  deleteShareGroup as deleteShareGroupCore,
  shareGroupInputSchema,
  updateShareGroup as updateShareGroupCore,
} from "@/lib/share-groups/store";
import { revalidateAfterAction } from "@/lib/revalidate";
import { createT } from "@spiralclass/shared";

// Legacy entry point for the community CRUD, kept for any caller that still
// imports it. The rules moved to lib/marketing/communities
// when the Facebook-group row became a marketing community (D-125); see
// docs/features/student-acquisition.md. These actions parse the form, scope to
// the signed-in teacher, and revalidate the communities editor.

export type ShareGroupState = { error?: string; ok?: boolean } | undefined;

const idField = z.string().uuid();

function invalid(t: TFunction): ShareGroupState {
  return {
    error: t("web.action.shareGroups.nameRequired"),
  };
}

function notFound(t: TFunction): ShareGroupState {
  return { error: t("web.action.shareGroups.notFound") };
}

// ---------- add ----------

export async function addShareGroup(
  _prev: ShareGroupState,
  formData: FormData,
): Promise<ShareGroupState> {
  const t = createT(await getPreferredLocale());
  const parsed = shareGroupInputSchema.safeParse({
    name: formData.get("name"),
    url: formData.get("url"),
  });
  if (!parsed.success) return invalid(t);

  const teacher = await requireOnboardedTeacher();
  await addShareGroupCore(teacher.id, parsed.data);

  revalidateAfterAction("/dashboard/get-students/communities");
  return { ok: true };
}

// ---------- update ----------

const updateSchema = shareGroupInputSchema.extend({ id: idField });

export async function updateShareGroup(
  _prev: ShareGroupState,
  formData: FormData,
): Promise<ShareGroupState> {
  const t = createT(await getPreferredLocale());
  const parsed = updateSchema.safeParse({
    id: formData.get("id"),
    name: formData.get("name"),
    url: formData.get("url"),
  });
  if (!parsed.success) return invalid(t);

  const { id, ...input } = parsed.data;
  const teacher = await requireOnboardedTeacher();
  const ok = await updateShareGroupCore(teacher.id, id, input);
  if (!ok) return notFound(t);

  revalidateAfterAction("/dashboard/get-students/communities");
  return { ok: true };
}

// ---------- delete ----------

const deleteSchema = z.object({ id: idField });

export async function deleteShareGroup(
  _prev: ShareGroupState,
  formData: FormData,
): Promise<ShareGroupState> {
  const t = createT(await getPreferredLocale());
  const parsed = deleteSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return invalid(t);

  const teacher = await requireOnboardedTeacher();
  const ok = await deleteShareGroupCore(teacher.id, parsed.data.id);
  if (!ok) return notFound(t);

  revalidateAfterAction("/dashboard/get-students/communities");
  return { ok: true };
}
