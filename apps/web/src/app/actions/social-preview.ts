"use server";

import { z } from "zod";
import {
  isSocialPreviewAngle,
  SOCIAL_PREVIEW_AI_FREE_MONTHLY_ALLOWANCE,
  SOCIAL_PREVIEW_CAPTION_MAX_CHARS,
  SOCIAL_PREVIEW_TOPIC_MAX_CHARS,
  type SocialPreviewAngle,
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
function generateErrorMessage(reason: string, en: boolean, cap?: number): string {
  switch (reason) {
    case "not-configured":
      return en
        ? "AI image generation isn't available right now. You can still upload your own image."
        : "La generación de imágenes con IA no está disponible ahora. Aún puedes subir tu propia imagen.";
    case "throttled":
      return en
        ? "You're generating too quickly — wait a few minutes and try again."
        : "Estás generando demasiado rápido — espera unos minutos e inténtalo de nuevo.";
    case "cap": {
      // The cap is always known when the domain returns "cap"; the fallback is
      // only so the message never reads "your undefined images".
      const limit = cap ?? SOCIAL_PREVIEW_AI_FREE_MONTHLY_ALLOWANCE;
      return en
        ? `You've used all ${limit} of this month's AI images. You can still upload your own.`
        : `Ya usaste las ${limit} imágenes con IA de este mes. Aún puedes subir las tuyas.`;
    }
    case "blocked":
      return en
        ? "The image service wouldn't make that one. Try describing it differently."
        : "El servicio de imágenes no pudo crear esa. Intenta describirla de otra forma.";
    case "timeout":
      return en
        ? "That took too long. Try again — nothing was used up."
        : "Tardó demasiado. Inténtalo de nuevo — no se usó nada.";
    default:
      return en
        ? "We couldn't create the image. Try again — nothing was used up."
        : "No pudimos crear la imagen. Inténtalo de nuevo — no se usó nada.";
  }
}

function uploadErrorMessage(reason: string, en: boolean): string {
  switch (reason) {
    case "type":
      return en ? "Choose a JPG, PNG or WebP image." : "Elige una imagen JPG, PNG o WebP.";
    case "empty":
      return en ? "That image is empty." : "Esa imagen está vacía.";
    case "too-large":
      return en ? "The image can't be larger than 5 MB." : "La imagen no puede pesar más de 5 MB.";
    default:
      return en ? "We couldn't upload that image." : "No pudimos subir esa imagen.";
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
  const en = (await getPreferredLocale()) === "en";
  const parsed = generateSchema.safeParse({
    angle: formData.get("angle"),
    topic: formData.get("topic") ?? undefined,
    communityId: formData.get("communityId") ?? undefined,
  });
  if (!parsed.success) {
    return { error: en ? "Pick a style for the image." : "Elige un estilo para la imagen." };
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
    return { error: generateErrorMessage(result.reason, en, result.quota?.cap) };
  }

  revalidate();
  return { ok: true, imageId: result.image.id };
}

// --- Upload ------------------------------------------------------------------

export async function uploadSocialPreview(
  _prev: SocialPreviewState,
  formData: FormData,
): Promise<SocialPreviewState> {
  const en = (await getPreferredLocale()) === "en";
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { error: en ? "Choose an image to upload." : "Elige una imagen para subir." };
  }

  const teacher = await requireOnboardedTeacher();
  const result = await uploadSocialPreviewImage({ teacherId: teacher.id, file });
  if (!result.ok) return { error: uploadErrorMessage(result.reason, en) };

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
  const en = (await getPreferredLocale()) === "en";
  const parsed = selectSchema.safeParse({
    imageId: formData.get("imageId"),
    shareGroupId: formData.get("shareGroupId") ?? "",
    caption: formData.get("caption") ?? undefined,
  });
  if (!parsed.success) {
    return { error: en ? "We couldn't use that image." : "No pudimos usar esa imagen." };
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
    return { error: en ? "We couldn't find that image." : "No encontramos esa imagen." };
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
  const en = (await getPreferredLocale()) === "en";
  const parsed = clearSchema.safeParse({ previewId: formData.get("previewId") });
  if (!parsed.success) {
    return { error: en ? "We couldn't reset that preview." : "No pudimos restablecer esa vista." };
  }

  const teacher = await requireOnboardedTeacher();
  const ok = await clearSocialPreview(teacher.id, parsed.data.previewId);
  if (!ok) {
    return { error: en ? "We couldn't find that preview." : "No encontramos esa vista." };
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
  const en = (await getPreferredLocale()) === "en";
  const parsed = renameSchema.safeParse({
    imageId: formData.get("imageId"),
    topic: formData.get("topic") ?? "",
  });
  if (!parsed.success) {
    return { error: en ? "We couldn't rename that image." : "No pudimos renombrar esa imagen." };
  }

  const teacher = await requireOnboardedTeacher();
  const ok = await renameSocialPreviewImage({
    teacherId: teacher.id,
    imageId: parsed.data.imageId,
    topic: parsed.data.topic,
  });
  if (!ok) {
    return { error: en ? "We couldn't find that image." : "No encontramos esa imagen." };
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
  const en = (await getPreferredLocale()) === "en";
  const parsed = deleteSchema.safeParse({ imageId: formData.get("imageId") });
  if (!parsed.success) {
    return { error: en ? "We couldn't delete that image." : "No pudimos borrar esa imagen." };
  }

  const teacher = await requireOnboardedTeacher();
  const result = await deleteSocialPreviewImage({
    teacherId: teacher.id,
    imageId: parsed.data.imageId,
  });

  if (!result.ok) {
    if (result.reason === "posted") {
      return {
        error: en
          ? "This image is part of a post you already marked as done, so it stays."
          : "Esta imagen es parte de una publicación que ya marcaste como hecha, así que se queda.",
      };
    }
    return { error: en ? "We couldn't find that image." : "No encontramos esa imagen." };
  }

  trackServerEvent({
    name: "social_preview_image_deleted",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id },
  });

  revalidate();
  return { ok: true };
}
