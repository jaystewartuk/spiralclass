import { randomUUID } from "node:crypto";
import {
  materialImageExtension,
  materialImageSrc,
  materialImageStoragePath,
  MAX_MATERIAL_IMAGE_BYTES,
} from "@spiralclass/shared";
import { logger } from "@/lib/logger";
import { getStorageProvider } from "./provider";
import { MATERIALS_BUCKET } from "./signed-urls";

const log = logger({ surface: "material-images" });

// Storage lifecycle for images embedded INSIDE a material body — the upload
// half of the `material-image:` scheme (packages/shared/src/material-doc/
// images.ts owns the reference format itself).
//
// Distinct from materials-upload.ts, which handles a material's single FILE
// attachment: an embedded image is one of many inside one body, is never
// linked to or downloaded on its own, and is keyed under a dedicated
// `library/images/` prefix so it is both purge-exempt and cheap to sweep when
// its material is hard-deleted.

export type MaterialImageUploadResult = { ok: { src: string; key: string } } | { error: string };

/** Store one image for `teacherId` and return the `src` a body should embed.
 *
 * Validation is by declared content type, not by extension: the extension is
 * DERIVED from the accepted type (materialImageExtension), so an uploaded
 * `evil.svg` announced as `image/png` is stored as `.png` and can only ever be
 * decoded as one — the filename never becomes a vector. */
export async function uploadMaterialImage(opts: {
  teacherId: string;
  file: File;
  en: boolean;
}): Promise<MaterialImageUploadResult> {
  const { teacherId, file, en } = opts;

  const extension = materialImageExtension(file.type ?? "");
  if (!extension) {
    return {
      error: en
        ? "Choose a JPG, PNG, WebP or GIF image."
        : "Elige una imagen JPG, PNG, WebP o GIF.",
    };
  }

  if (file.size <= 0) {
    return { error: en ? "That image is empty." : "Esa imagen está vacía." };
  }

  if (file.size > MAX_MATERIAL_IMAGE_BYTES) {
    const mb = Math.floor(MAX_MATERIAL_IMAGE_BYTES / (1024 * 1024));
    return {
      error: en
        ? `The image can't be larger than ${mb} MB.`
        : `La imagen no puede pesar más de ${mb} MB.`,
    };
  }

  // Timestamp for rough ordering when browsing the bucket, random suffix so a
  // key is never guessable — the access check is teacher-scoped, not
  // per-material, so unguessability is part of the security story (see
  // lib/materials/image-access.ts).
  const unique = `${Date.now()}-${randomUUID().slice(0, 12)}`;
  const key = materialImageStoragePath(teacherId, unique, extension);

  const { error } = await getStorageProvider().upload(MATERIALS_BUCKET, key, file, {
    contentType: file.type,
    upsert: false,
  });
  if (error) {
    log.warn("upload failed", { error: error.message });
    return {
      error: en
        ? `We couldn't upload the image: ${error.message}`
        : `No pudimos subir la imagen: ${error.message}`,
    };
  }

  return { ok: { src: materialImageSrc(key), key } };
}

/** Best-effort removal of images a hard-deleted material embedded.
 *
 * Best-effort on purpose, exactly like `removeMaterialObject`: a storage error
 * must not strand the row deletion the caller is committing. Archiving never
 * calls this — an archived material is restorable, and freeing its pictures
 * would restore it blind. */
export async function removeMaterialImages(keys: string[]): Promise<void> {
  if (!keys.length) return;
  const { error } = await getStorageProvider().remove(MATERIALS_BUCKET, keys);
  if (error) {
    log.warn("remove failed", { error: error.message, count: keys.length });
  }
}
