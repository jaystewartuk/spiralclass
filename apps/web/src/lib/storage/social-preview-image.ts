import { SOCIAL_PREVIEW_MAX_UPLOAD_BYTES, SOCIAL_PREVIEW_UPLOAD_TYPES } from "@spiralclass/shared";
import { getStorageProvider, PUBLIC_VERSIONED_ASSET_CACHE_CONTROL } from "./provider";
import { r2PublicUrl } from "./r2-public-url";
import { TEACHER_PHOTO_BUCKET } from "./teacher-photo";

// Storage lifecycle for social-preview BACKGROUNDS (D-123).
//
// These live in the SAME public bucket as teacher profile photos and
// testimonial avatars (`teacher-photos`), under the teacher's own prefix:
// `${teacherId}/social/${imageId}.${ext}`. Three reasons this is not a new
// bucket:
//
//  * It must be public. Social crawlers (Facebook, WhatsApp, LinkedIn, X) fetch
//    an og:image with no credentials, so a signed URL is structurally unusable
//    here — the same constraint that put teacher photos in a public bucket.
//  * That bucket is already provisioned, already CDN-fronted, and already has
//    its NEXT_PUBLIC_..._R2_PUBLIC_URL base wired through r2-public-url.ts. A
//    new bucket means new Terraform (infra/cloudflare-r2/variables.tf), a new
//    entry in provider.ts's R2_ENV_PREFIX, and five new env vars in each of
//    three environments — for no behavioural gain.
//  * Testimonial avatars already establish the `${teacherId}/…` sub-prefix
//    convention inside it, so this follows a path other code already reads.
//
// Objects are immutable: the key contains the image row's uuid and is never
// reused, so a re-upload is a new row and a new key. That is what lets the
// long immutable cache below be safe here even though — unlike teacher photos —
// these URLs carry no `?v=` cache-buster of their own.

export const SOCIAL_PREVIEW_BUCKET = TEACHER_PHOTO_BUCKET;

export { SOCIAL_PREVIEW_MAX_UPLOAD_BYTES, SOCIAL_PREVIEW_UPLOAD_TYPES };

export function socialPreviewStorageKey(
  teacherId: string,
  imageId: string,
  extension: string,
): string {
  return `${teacherId}/social/${imageId}.${extension}`;
}

/** Public URL of a stored background. Pure and credential-free, so it is safe
 * to call during render and from a client component. */
export function socialPreviewImagePublicUrl(path: string | null | undefined): string | null {
  return r2PublicUrl(SOCIAL_PREVIEW_BUCKET, path);
}

/** Store one background. `body` is a File (upload path) or raw bytes (AI path);
 * both are accepted by the provider's StorageBody contract. */
export async function putSocialPreviewImage(opts: {
  teacherId: string;
  imageId: string;
  extension: string;
  contentType: string;
  body: File | Uint8Array;
}): Promise<{ path: string; error: string | null }> {
  const path = socialPreviewStorageKey(opts.teacherId, opts.imageId, opts.extension);
  const { error } = await getStorageProvider().upload(SOCIAL_PREVIEW_BUCKET, path, opts.body, {
    contentType: opts.contentType,
    // The key is uuid-derived and never reused, so there is nothing to
    // overwrite; false makes a key collision a loud error rather than a silent
    // clobber of somebody's live preview.
    upsert: false,
    // Safe here because the key itself is immutable — see the header note.
    cacheControl: PUBLIC_VERSIONED_ASSET_CACHE_CONTROL,
  });
  return { path, error: error?.message ?? null };
}

/** Best-effort removal, mirroring removeTeacherPhoto: a storage failure must
 * never strand the row deletion the caller is committing. */
export async function removeSocialPreviewImage(path: string): Promise<void> {
  await getStorageProvider()
    .remove(SOCIAL_PREVIEW_BUCKET, [path])
    .catch(() => {});
}
