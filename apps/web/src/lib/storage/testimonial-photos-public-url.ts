import { r2PublicUrl } from "./r2-public-url";

// The PURE half of testimonial-photos.ts — paths, the public URL, and the two
// upload limits — so CLIENT components can import them without pulling in that
// file's `getStorageProvider` import, which chains into the SigV4 presigner
// (lib/aws/sigv4.ts) and node:crypto — fine on the server, but it breaks the
// client webpack bundle ("node:crypto" has no browser polyfill).
//
// The editor (testimonial-forms.tsx) needs the limits, not just the URL: it
// checks a picked file BEFORE spending an upload on it, and it must reject the
// same files the server does. Two numbers that have to agree belong in one
// place, and this is the only one of the two files a browser can reach.

// Testimonial author avatars live in the SAME public bucket as teacher profile
// photos (`teacher-photos`). The path pattern `${teacherId}/testimonials/${testimonialId}`
// namespaces them cleanly under the teacher's own prefix and prevents collisions
// with the top-level `${teacherId}` teacher-profile object.
export const TESTIMONIAL_PHOTO_BUCKET = "teacher-photos";

export function testimonialPhotoStoragePath(teacherId: string, testimonialId: string): string {
  return `${teacherId}/testimonials/${testimonialId}`;
}

// Public URL for a stored testimonial photo. Returns null when there is no
// photo or the backend URL isn't configured. Pure + credential-free, safe to
// call during render on the server OR the client.
export function testimonialPhotoPublicUrl(photoPath: string | null | undefined): string | null {
  return r2PublicUrl(TESTIMONIAL_PHOTO_BUCKET, photoPath);
}

// 5 MB — this is an avatar, not a document.
export const TESTIMONIAL_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

// MIME type → extension. Also the `accept` list the file input advertises, so
// the picker offers exactly what the server will keep.
export const ALLOWED_TESTIMONIAL_PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
