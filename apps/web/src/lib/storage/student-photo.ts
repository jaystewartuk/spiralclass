import { getStorageProvider } from "./provider";

// Student profile photos live in a PRIVATE bucket — unlike teacher photos
// (public: booking page + OG crawlers need an unauthenticated URL), students
// have no public-facing page, so every read goes through a short-lived signed
// URL instead. One object per student, keyed by id, so a re-upload replaces
// in place (no orphans).

export const STUDENT_PHOTO_BUCKET = "student-photos";
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB
const SIGNED_URL_TTL_SECONDS = 300;

// content-type → extension for the allowed image formats.
export const ALLOWED_PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function studentPhotoStorageKey(studentId: string): string {
  return `${studentId}`;
}

// Short-lived signed URL for a stored photo, or null when there's no photo or
// signing fails. Unlike teacherPhotoPublicUrl this is ASYNC — every caller
// (page render, mobile /auth/me, mobile photo route) must await it.
export async function studentPhotoUrl(
  photoPath: string | null | undefined,
): Promise<string | null> {
  if (!photoPath) return null;
  return getStorageProvider().createSignedUrl(
    STUDENT_PHOTO_BUCKET,
    photoPath,
    SIGNED_URL_TTL_SECONDS,
  );
}

// Idempotently ensure the private bucket exists (self-provisions preview /
// dev environments; prod is created out-of-band too).
export async function ensureStudentPhotoBucket(): Promise<void> {
  await getStorageProvider().ensureBucket(STUDENT_PHOTO_BUCKET, {
    public: false,
    fileSizeLimit: MAX_PHOTO_BYTES,
    allowedMimeTypes: Object.keys(ALLOWED_PHOTO_TYPES),
  });
}

// Stores a student's photo (one object per student, replace in place) and
// returns its storage key. Callers never touch the storage backend directly,
// and validate type/size
// first; this provisions the bucket then uploads.
export async function putStudentPhoto(
  studentId: string,
  file: File,
): Promise<{ path: string; error: string | null }> {
  await ensureStudentPhotoBucket();
  const path = studentPhotoStorageKey(studentId);
  const { error } = await getStorageProvider().upload(STUDENT_PHOTO_BUCKET, path, file, {
    contentType: file.type,
    upsert: true,
  });
  return { path, error: error?.message ?? null };
}

// Best-effort removal of a student's photo object (hard delete). Mirrors
// putStudentPhoto so a cleared pointer doesn't leak the stored object.
export async function removeStudentPhoto(photoPath: string): Promise<void> {
  await getStorageProvider()
    .remove(STUDENT_PHOTO_BUCKET, [photoPath])
    .catch(() => {});
}
