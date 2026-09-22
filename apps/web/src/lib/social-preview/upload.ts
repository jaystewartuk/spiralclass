import "server-only";
import { randomUUID } from "node:crypto";
import {
  SOCIAL_PREVIEW_HEIGHT,
  SOCIAL_PREVIEW_MAX_UPLOAD_BYTES,
  SOCIAL_PREVIEW_WIDTH,
  socialPreviewUploadExtension,
  type SocialPreviewImageView,
} from "@spiralclass/shared";
import { logger } from "@/lib/logger";
import {
  putSocialPreviewImage,
  socialPreviewImagePublicUrl,
} from "@/lib/storage/social-preview-image";
import { createSocialPreviewImage } from "./store";

const log = logger({ surface: "social-preview" });

// The upload half of the social-preview asset model (D-123).
//
// A teacher who already makes images elsewhere — ChatGPT, Canva, her phone —
// must not be pushed through generation to use them, and the two rails
// deliberately produce the SAME SocialPreviewImage row so nothing downstream
// (selection, composition, the OG resolver, analytics) ever branches on where
// an image came from. Uploads are NOT capped: no cost is incurred, and capping
// them would only punish the teacher for not using the expensive path.

export type UploadSocialPreviewResult =
  | { ok: true; image: SocialPreviewImageView }
  | { ok: false; reason: "type" | "empty" | "too-large" | "storage" };

export async function uploadSocialPreviewImage(input: {
  teacherId: string;
  file: File;
}): Promise<UploadSocialPreviewResult> {
  const { teacherId, file } = input;

  // By DECLARED content type, with the extension derived from it — so a
  // `payload.svg` announced as image/png is stored as `.png` and can only ever
  // be decoded as one. Same rule as lib/storage/material-images.ts.
  const extension = socialPreviewUploadExtension(file.type ?? "");
  if (!extension) return { ok: false, reason: "type" };
  if (file.size <= 0) return { ok: false, reason: "empty" };
  if (file.size > SOCIAL_PREVIEW_MAX_UPLOAD_BYTES) return { ok: false, reason: "too-large" };

  const imageId = randomUUID();
  const { path, error } = await putSocialPreviewImage({
    teacherId,
    imageId,
    extension,
    contentType: file.type,
    body: file,
  });
  if (error) {
    log.warn("upload failed", { teacherId, error });
    return { ok: false, reason: "storage" };
  }

  const row = await createSocialPreviewImage({
    id: imageId,
    teacherId,
    source: "upload",
    // No angle: she never declared one, and inventing one would put a guess
    // into the very dimension the analytics breakdown is built on.
    angle: null,
    storagePath: path,
    // The canvas the composer renders into. We deliberately do not decode the
    // upload to read its true pixel size: the composer covers to this box
    // regardless, so the real dimensions change nothing, and decoding
    // arbitrary uploaded bytes server-side is a risk taken for no benefit.
    width: SOCIAL_PREVIEW_WIDTH,
    height: SOCIAL_PREVIEW_HEIGHT,
  });

  return {
    ok: true,
    image: {
      id: row.id,
      source: row.source,
      angle: row.angle,
      topic: row.topic,
      url: socialPreviewImagePublicUrl(row.storagePath),
      createdAt: row.createdAt.toISOString(),
    },
  };
}
