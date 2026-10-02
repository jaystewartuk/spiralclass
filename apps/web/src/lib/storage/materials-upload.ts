import { type TFunction, issueMessage } from "@spiralclass/shared";
import { z } from "zod";
import { getStorageProvider } from "./provider";
import { MATERIALS_BUCKET } from "./signed-urls";
import { logger } from "@/lib/logger";

const log = logger({ surface: "materials" });

// Shared upload core for material attachments — used by both the per-class
// action (src/app/actions/materials.ts) and the level library
// (src/app/actions/library.ts). Both put files into the private
// `class-materials` bucket via the service-role client; tenancy is enforced by
// the caller (verified teacher) plus the path prefix.

export const MAX_MATERIAL_BYTES = 25 * 1024 * 1024; // 25 MB

export const materialLinkSchema = z.string().url("web.action.library.invalidUrl");

export type MaterialAttachment =
  { kind: "file"; storagePath: string } | { kind: "link"; linkUrl: string };

export type MaterialAttachmentResult = { ok: MaterialAttachment } | { error: string };

// Resolves a file OR a link into a normalized attachment, putting any file into
// storage under `pathPrefix`. Returns a localized error string on failure.
//   pathPrefix — e.g. `${teacherId}/${bookingId}` (per-class) or
//                `${teacherId}/library` (library). The object name is
//                appended as `${pathPrefix}/${Date.now()}-${file.name}`.
export async function resolveMaterialAttachment(opts: {
  file: unknown;
  linkUrl: string;
  pathPrefix: string;
  t: TFunction;
}): Promise<MaterialAttachmentResult> {
  const { file, linkUrl, pathPrefix, t } = opts;

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_MATERIAL_BYTES) {
      return {
        error: t("web.action.materialFile.tooLarge"),
      };
    }
    const path = `${pathPrefix}/${Date.now()}-${file.name}`;
    const { error: upErr } = await getStorageProvider().upload(MATERIALS_BUCKET, path, file, {
      contentType: file.type,
      upsert: false,
    });
    if (upErr) {
      log.warn("upload failed", { error: upErr.message });
      return {
        error: t("web.action.materialFile.uploadFailed", { message: upErr.message }),
      };
    }
    return { ok: { kind: "file", storagePath: path } };
  }

  const trimmed = linkUrl.trim();
  if (trimmed) {
    const parsed = materialLinkSchema.safeParse(trimmed);
    if (!parsed.success) {
      return { error: issueMessage(parsed.error, t, "web.action.library.invalidUrl") };
    }
    return { ok: { kind: "link", linkUrl: parsed.data } };
  }

  return {
    error: t("materials.noAttachment"),
  };
}

// Best-effort removal of a stored material object (hard delete). Mirrors the
// purge path in materials-purge.ts so the storage object is freed, not leaked.
export async function removeMaterialObject(storagePath: string): Promise<void> {
  const { error } = await getStorageProvider().remove(MATERIALS_BUCKET, [storagePath]);
  if (error) {
    log.warn("remove failed", { error: error.message });
  }
}
