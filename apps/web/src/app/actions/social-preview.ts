"use server";

import type { TFunction } from "@spiralclass/shared";
import { z } from "zod";
import {
  isSocialPreviewAngle,
  SOCIAL_PREVIEW_AI_FREE_MONTHLY_ALLOWANCE,
  SOCIAL_PREVIEW_CAPTION_MAX_CHARS,
  SOCIAL_PREVIEW_TOPIC_MAX_CHARS,
  type SocialPreviewAngle,
  createT,
} from "@spiralclass/shared";
import { requireOnboardedTeacher } from "@/lib/auth";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { getPreferredLocale } from "@/lib/i18n";
import { generateSocialPreviewImage } from "@/lib/social-preview/generate";
import {
  clearSocialPreview,
  deleteSocialPreviewImage,
  renameSocialPreviewImage,
  selectSocialPreview,
} from "@/lib/social-preview/store";
import { uploadSocialPreviewImage } from "@/lib/social-preview/upload";
import { loadEntitlements } from "@/lib/subscriptions/service";
import { revalidateAfterAction } from "@/lib/revalidate";

// Social-preview server actions (D-123). The rules live in
// lib/social-preview/*; these parse the
// form, scope everything to the signed-in teacher, translate the domain's
// failure vocabulary into her language, and revalidate the editor.
//
// Authorization is uniform and deliberate: every action starts at
// requireOnboardedTeacher() and passes teacher.id into the store, which
// re-checks ownership of BOTH the image and the group on the one write that can
// point a public surface at an asset. No action accepts a teacherId from the
// client.

export type SocialPreviewState = { error?: string; ok?: boolean; imageId?: string } | undefined;

const PREVIEW_PATH = "/dashboard/get-students/communities";

function revalidate() {
  revalidateAfterAction(PREVIEW_PATH);
}

// --- Messages ----------------------------------------------------------------

// One table, so no two callers can describe the same failure differently.
// Keyed by the reason unions the domain returns.
function generateErrorMessage(reason: string, t: TFunction, cap?: number): string {
  switch (reason) {
    case "not-configured":
      return t("web.action.socialPreview.aiUnavailable");
    case "throttled":
      return t("web.action.socialPreview.tooFast");
    case "cap": {
      // The cap is always known when the domain returns "cap"; the fallback is
      // only so the message never reads "your undefined images".
      const limit = cap ?? SOCIAL_PREVIEW_AI_FREE_MONTHLY_ALLOWANCE;
      return t("web.action.socialPreview.quotaUsed", { limit });
    }
    case "blocked":
      return t("web.action.socialPreview.refused");
    case "timeout":
      return t("web.action.socialPreview.timedOut");
    default:
      return t("web.action.socialPreview.createFailed");
  }
}

function uploadErrorMessage(reason: string, t: TFunction): string {
  switch (reason) {
    case "type":
      return t("web.action.socialPreview.chooseType");
    case "empty":
      return t("web.action.socialPreview.empty");
    case "too-large":
      return t("web.action.socialPreview.tooLarge");
    default:
      return t("material.editor.block.imageUploadFailed");
  }
}

// --- Generate ----------------------------------------------------------------

const generateSchema = z.object({
  angle: z.string().refine(isSocialPreviewAngle, "angle"),
  topic: z.string().trim().max(SOCIAL_PREVIEW_TOPIC_MAX_CHARS).optional(),
  // Which community the image is for, so her instructions FOR THAT AUDIENCE
  // reach the brief. Empty string = the teacher's default preview, which has
  // no community and therefore no community brief.
  communityId: z.union([z.string().uuid(), z.literal("")]).optional(),
});

export async function generateSocialPreview(
  _prev: SocialPreviewState,
  formData: FormData,
): Promise<SocialPreviewState> {
  const t = createT(await getPreferredLocale());
  const parsed = generateSchema.safeParse({
    angle: formData.get("angle"),
    topic: formData.get("topic") ?? undefined,
    communityId: formData.get("communityId") ?? undefined,
  });
  if (!parsed.success) {
    return { error: t("web.action.socialPreview.pickStyle") };
  }

  const teacher = await requireOnboardedTeacher();
  const entitlements = await loadEntitlements(teacher.id);

  const result = await generateSocialPreviewImage({
    teacherId: teacher.id,
    isPro: entitlements.isPro,
    teachingLanguage: teacher.teachingLanguage,
    angle: parsed.data.angle as SocialPreviewAngle,
    topic: parsed.data.topic,
    // Ownership of this id is re-checked inside the domain, so a forged one
    // yields no community context rather than another teacher's.
    communityId: parsed.data.communityId || null,
  });

  trackServerEvent({
    name: "social_preview_generated",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      angle: parsed.data.angle,
      hasTopic: Boolean(parsed.data.topic),
      forCommunity: Boolean(parsed.data.communityId),
      ok: result.ok,
      ...(result.ok ? {} : { reason: result.reason }),
    },
  });

  if (!result.ok) {
    return { error: generateErrorMessage(result.reason, t, result.quota?.cap) };
  }

  revalidate();
  return { ok: true, imageId: result.image.id };
}

// --- Upload ------------------------------------------------------------------

export async function uploadSocialPreview(
  _prev: SocialPreviewState,
  formData: FormData,
): Promise<SocialPreviewState> {
  const t = createT(await getPreferredLocale());
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { error: t("web.action.socialPreview.chooseUpload") };
  }

  const teacher = await requireOnboardedTeacher();
  const result = await uploadSocialPreviewImage({ teacherId: teacher.id, file });
  if (!result.ok) return { error: uploadErrorMessage(result.reason, t) };

  revalidate();
  return { ok: true, imageId: result.image.id };
}

// --- Select ------------------------------------------------------------------

const selectSchema = z.object({
  imageId: z.string().uuid(),
  // Empty string = the teacher's default preview (untagged shares), not "no
  // group chosen" — a distinction the form has to be able to express.
  shareGroupId: z.union([z.string().uuid(), z.literal("")]),
  caption: z
    .string()
    .max(SOCIAL_PREVIEW_CAPTION_MAX_CHARS * 2)
    .optional(),
});

export async function useSocialPreview(
  _prev: SocialPreviewState,
  formData: FormData,
): Promise<SocialPreviewState> {
  const t = createT(await getPreferredLocale());
  const parsed = selectSchema.safeParse({
    imageId: formData.get("imageId"),
    shareGroupId: formData.get("shareGroupId") ?? "",
    caption: formData.get("caption") ?? undefined,
  });
  if (!parsed.success) {
    return { error: t("web.action.socialPreview.unusable") };
  }

  const teacher = await requireOnboardedTeacher();
  const result = await selectSocialPreview({
    teacherId: teacher.id,
    imageId: parsed.data.imageId,
    shareGroupId: parsed.data.shareGroupId || null,
    caption: parsed.data.caption ?? "",
  });

  if (!result.ok) {
    // Both reasons mean "not yours or gone"; they are never distinguished for
    // the caller, so one teacher can't probe another's ids.
    return { error: t("web.action.socialPreview.imageNotFound") };
  }

  trackServerEvent({
    name: "social_preview_selected",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      source: result.preview.image.source,
      angle: result.preview.image.angle,
      shareGroupId: result.preview.shareGroupId,
    },
  });

  revalidate();
  return { ok: true };
}

// --- Clear -------------------------------------------------------------------

const clearSchema = z.object({ previewId: z.string().uuid() });

export async function removeSocialPreview(
  _prev: SocialPreviewState,
  formData: FormData,
): Promise<SocialPreviewState> {
  const t = createT(await getPreferredLocale());
  const parsed = clearSchema.safeParse({ previewId: formData.get("previewId") });
  if (!parsed.success) {
    return { error: t("web.action.socialPreview.resetFailed") };
  }

  const teacher = await requireOnboardedTeacher();
  const ok = await clearSocialPreview(teacher.id, parsed.data.previewId);
  if (!ok) {
    return { error: t("web.action.socialPreview.previewNotFound") };
  }

  revalidate();
  return { ok: true };
}

// --- Rename / delete ---------------------------------------------------------

const renameSchema = z.object({
  imageId: z.string().uuid(),
  topic: z.string().trim().max(SOCIAL_PREVIEW_TOPIC_MAX_CHARS),
});

/** The one editable property on a stored image: her own label for it. */
export async function renameSocialPreviewImageAction(
  _prev: SocialPreviewState,
  formData: FormData,
): Promise<SocialPreviewState> {
  const t = createT(await getPreferredLocale());
  const parsed = renameSchema.safeParse({
    imageId: formData.get("imageId"),
    topic: formData.get("topic") ?? "",
  });
  if (!parsed.success) {
    return { error: t("web.action.socialPreview.renameFailed") };
  }

  const teacher = await requireOnboardedTeacher();
  const ok = await renameSocialPreviewImage({
    teacherId: teacher.id,
    imageId: parsed.data.imageId,
    topic: parsed.data.topic,
  });
  if (!ok) {
    return { error: t("web.action.socialPreview.imageNotFound") };
  }

  revalidate();
  return { ok: true };
}

const deleteSchema = z.object({ imageId: z.string().uuid() });

/**
 * Delete an image for good, bytes included.
 *
 * The authorization that matters is in the domain, not here: the store scopes
 * both the lookup and every cascade to `teacher.id`, so a forged id is a
 * not-found rather than someone else's asset. The one refusal it can return is
 * "you already posted this", which is a real answer and gets its own message.
 */
export async function deleteSocialPreviewImageAction(
  _prev: SocialPreviewState,
  formData: FormData,
): Promise<SocialPreviewState> {
  const t = createT(await getPreferredLocale());
  const parsed = deleteSchema.safeParse({ imageId: formData.get("imageId") });
  if (!parsed.success) {
    return { error: t("web.action.socialPreview.deleteFailed") };
  }

  const teacher = await requireOnboardedTeacher();
  const result = await deleteSocialPreviewImage({
    teacherId: teacher.id,
    imageId: parsed.data.imageId,
  });

  if (!result.ok) {
    if (result.reason === "posted") {
      return {
        error: t("web.action.socialPreview.partOfDonePost"),
      };
    }
    return { error: t("web.action.socialPreview.imageNotFound") };
  }

  trackServerEvent({
    name: "social_preview_image_deleted",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id },
  });

  revalidate();
  return { ok: true };
}
