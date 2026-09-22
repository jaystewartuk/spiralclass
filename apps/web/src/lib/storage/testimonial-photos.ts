import { getStorageProvider } from "./provider";
import {
  TESTIMONIAL_PHOTO_BUCKET,
  testimonialPhotoStoragePath,
} from "./testimonial-photos-public-url";

// Testimonial author avatars live in the SAME public bucket as teacher profile
// photos (`teacher-photos`). The path pattern `${teacherId}/testimonials/${testimonialId}`
// namespaces them cleanly under the teacher's own prefix and prevents collisions
// with the top-level `${teacherId}` teacher-profile object.
//
// The bucket is already public (the booking page and social crawlers fetch
// teacher photos without auth), so these avatars need no signed URLs either.
//
// `TESTIMONIAL_PHOTO_BUCKET`, `testimonialPhotoStoragePath`, and
// `testimonialPhotoPublicUrl` live in ./testimonial-photos-public-url (a pure
// module with no provider.ts/node:crypto dependency) so the CLIENT component
// (testimonial-forms.tsx) can import the public-url helper directly without
// pulling this file's server-only upload/remove machinery into its bundle.
export {
  TESTIMONIAL_PHOTO_BUCKET,
  testimonialPhotoStoragePath,
  testimonialPhotoPublicUrl,
  // The size cap and the accepted MIME types moved to the pure module too: the
  // editor checks a picked file against them before spending an upload, and the
  // client cannot import this file. Re-exported so server callers are unchanged.
  TESTIMONIAL_PHOTO_MAX_BYTES,
  ALLOWED_TESTIMONIAL_PHOTO_TYPES,
} from "./testimonial-photos-public-url";

// Upload a testimonial author photo. Overwrites any previous object at the
// same path (upsert). Returns the storage path on success.
export async function uploadTestimonialPhoto(
  teacherId: string,
  testimonialId: string,
  file: File,
): Promise<{ storagePath: string; error: null } | { storagePath: null; error: string }> {
  const path = testimonialPhotoStoragePath(teacherId, testimonialId);
  const { error } = await getStorageProvider().upload(TESTIMONIAL_PHOTO_BUCKET, path, file, {
    contentType: file.type,
    upsert: true,
  });
  if (error) return { storagePath: null, error: error.message };
  return { storagePath: path, error: null };
}

// Best-effort removal of a testimonial photo. Mirrors removeTeacherPhoto.
export async function removeTestimonialPhoto(photoPath: string): Promise<void> {
  await getStorageProvider()
    .remove(TESTIMONIAL_PHOTO_BUCKET, [photoPath])
    .catch(() => {});
}
