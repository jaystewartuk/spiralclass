import "server-only";
import { materialImageExtension, type TFunction } from "@spiralclass/shared";
import { generateImage } from "@/lib/ai/image-gen";
import { hasGeminiImageCreds } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { uploadMaterialImage } from "@/lib/storage/material-images";
import { buildMaterialImagePrompt } from "./image-prompt";

const log = logger({ surface: "material-images" });

// One generated image for a material body, end to end: the teacher describes
// a picture in the block editor, and gets back the same `material-image:` src
// an upload would have given her. From there it IS an uploaded image: stored
// under the same purge-exempt prefix, served by the same authenticated route,
// freed by the same hard-delete sweep. Nothing downstream knows it was
// generated, which is the point: there is no second kind of image to support.
//
// Every cheap refusal happens before the paid call:
//   credentials -> short throttle -> daily budget -> provider -> storage.
// The Pro gate is the caller's (the route), the same split the upload route
// uses.

/**
 * The bad-minute throttle: a double-click storm or a stuck retry. Six in ten
 * minutes is well above someone generating, looking, and trying again.
 */
const GENERATE_BURST = { scope: "material-image-generate", limit: 6, windowMs: 10 * 60_000 };

/**
 * The day's budget per teacher. It bounds what one account can spend on the
 * provider, at a size no real material-writing day reaches (a material with
 * five scenes, generated twice each, is ten). The in-memory limiter resets on
 * a cold start, so this is a ceiling on a bad day, not an exact ledger.
 */
const GENERATE_DAILY = {
  scope: "material-image-generate-day",
  limit: 30,
  windowMs: 24 * 60 * 60_000,
};

export type GenerateMaterialImageResult =
  | { ok: true; src: string }
  | {
      ok: false;
      reason:
        "not-configured" | "throttled" | "blocked" | "timeout" | "empty" | "storage" | "error";
      message: string;
    };

/** Whether this deployment can generate material images at all. The editor
 * offers the control only when this is true. */
export function materialImageGenerationAvailable(): boolean {
  return hasGeminiImageCreds();
}

export async function generateMaterialImage(opts: {
  teacherId: string;
  description: string;
  t: TFunction;
}): Promise<GenerateMaterialImageResult> {
  const { teacherId, description, t } = opts;
  const fail = (
    reason: Exclude<GenerateMaterialImageResult, { ok: true }>["reason"],
  ): GenerateMaterialImageResult => ({ ok: false, reason, message: messageFor(reason, t) });

  if (!materialImageGenerationAvailable()) return fail("not-configured");

  const burst = await rateLimit(teacherId, GENERATE_BURST);
  if (!burst.ok) return fail("throttled");
  const daily = await rateLimit(teacherId, GENERATE_DAILY);
  if (!daily.ok) return fail("throttled");

  const generated = await generateImage(buildMaterialImagePrompt(description), {
    aspectRatio: "4:3",
  });
  if (!generated.ok) {
    log.warn("generation failed", { teacherId, reason: generated.reason });
    return fail(generated.reason);
  }

  // Stored through the upload path, so a generated picture passes the same
  // type and size checks as one a teacher chose from her phone. A provider
  // answering in a type the materials surfaces do not serve is refused here
  // rather than stored as something it is not.
  const { contentType, bytes } = generated.image;
  const extension = materialImageExtension(contentType);
  if (!extension) {
    log.warn("generated image in an unsupported type", { teacherId, contentType });
    return fail("error");
  }
  const file = new File([Buffer.from(bytes)], `generated.${extension}`, { type: contentType });
  const stored = await uploadMaterialImage({ teacherId, file, t });
  if ("error" in stored) return fail("storage");

  return { ok: true, src: stored.ok.src };
}

function messageFor(
  reason: Exclude<GenerateMaterialImageResult, { ok: true }>["reason"],
  t: TFunction,
): string {
  switch (reason) {
    case "not-configured":
      return t("material.editor.block.imageGenerate.unavailable");
    case "throttled":
      return t("material.editor.block.imageGenerate.tooMany");
    case "blocked":
      return t("material.editor.block.imageGenerate.refused");
    case "timeout":
      return t("material.editor.block.imageGenerate.timedOut");
    default:
      return t("material.editor.block.imageGenerate.failed");
  }
}
