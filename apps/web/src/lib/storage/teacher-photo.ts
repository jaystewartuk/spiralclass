import { getStorageProvider, PUBLIC_VERSIONED_ASSET_CACHE_CONTROL } from "./provider";
import { r2PublicUrl } from "./r2-public-url";

// Teacher profile photos live in a PUBLIC bucket (the booking page is public
// and social/OG crawlers fetch the image without auth, so signed URLs won't
// do). One object per teacher, keyed by id, so a re-upload replaces in place
// (no orphans); a `?v=` cache-buster busts the CDN copy.

export const TEACHER_PHOTO_BUCKET = "teacher-photos";
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB

// content-type → extension for the allowed image formats.
export const ALLOWED_PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function teacherPhotoStorageKey(teacherId: string): string {
  return `${teacherId}`;
}

// Public URL for a stored photo. `version` (e.g. teacher.updatedAt) busts the
// CDN cache after a re-upload. Returns null when there's no photo or the
// backend URL isn't configured. Credential-free, safe to call during render.
export function teacherPhotoPublicUrl(
  photoPath: string | null | undefined,
  version?: number,
): string | null {
  return r2PublicUrl(TEACHER_PHOTO_BUCKET, photoPath, version);
}

// Idempotently ensure the public bucket exists (self-provisions preview / dev
// environments; prod is created out-of-band too).
export async function ensureTeacherPhotoBucket(): Promise<void> {
  await getStorageProvider().ensureBucket(TEACHER_PHOTO_BUCKET, {
    public: true,
    fileSizeLimit: MAX_PHOTO_BYTES,
    allowedMimeTypes: Object.keys(ALLOWED_PHOTO_TYPES),
  });
}

// Stores a teacher's photo (one object per teacher, replace in place) and
// returns its storage key. Callers never touch the storage backend directly,
// and validate type/size
// first; this provisions the bucket then uploads.
export async function putTeacherPhoto(
  teacherId: string,
  file: File,
): Promise<{ path: string; error: string | null }> {
  await ensureTeacherPhotoBucket();
  const path = teacherPhotoStorageKey(teacherId);
  const { error } = await getStorageProvider().upload(TEACHER_PHOTO_BUCKET, path, file, {
    contentType: file.type,
    upsert: true,
    // Safe long cache here specifically because the public URL always carries
    // a `?v=` cache-buster (teacherPhotoPublicUrl) — see provider.ts.
    cacheControl: PUBLIC_VERSIONED_ASSET_CACHE_CONTROL,
  });
  return { path, error: error?.message ?? null };
}

// Best-effort removal of a teacher's photo object (hard delete). Mirrors
// putTeacherPhoto so a cleared pointer doesn't leak the stored object.
export async function removeTeacherPhoto(photoPath: string): Promise<void> {
  await getStorageProvider()
    .remove(TEACHER_PHOTO_BUCKET, [photoPath])
    .catch(() => {});
}
