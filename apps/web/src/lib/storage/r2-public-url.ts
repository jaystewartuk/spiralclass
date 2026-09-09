// Pure, dependency-free public-URL builder for R2-backed public buckets.
//
// This is split out of provider.ts specifically so it can be imported from
// CLIENT components (e.g. testimonial-forms.tsx renders a photo URL from a
// bare path). provider.ts pulls in the SigV4 presigner (lib/aws/sigv4.ts),
// which uses node:crypto and breaks the client webpack bundle if imported
// there — this file has zero such dependencies.
//
// The public-URL base is read from a NEXT_PUBLIC_-prefixed env var (unlike
// every other R2_* var, which stays server-only) because it's non-secret and
// must be available to client-side re-renders, not just the initial SSR
// pass — mirroring how the old Supabase provider read NEXT_PUBLIC_SUPABASE_URL.

// IMPORTANT: read the env var via STATIC member access
// (`process.env.NEXT_PUBLIC_TEACHER_PHOTOS_R2_PUBLIC_URL`), never a computed
// key like `process.env[`NEXT_PUBLIC_${prefix}_R2_PUBLIC_URL`]`. Next.js only
// inlines NEXT_PUBLIC_* vars into the CLIENT bundle when the key is a literal;
// a computed key is left as-is and resolves to `undefined` in the browser, so
// the URL would render on the server then vanish (and mismatch) on hydration.
// teacher-photos and teacher-videos are the public buckets (both feed the
// unauthenticated /b/<slug> page); class-materials is private and has no public
// URL, so it falls through to `undefined` → null.
function r2PublicBase(bucket: string): string | undefined {
  switch (bucket) {
    case "teacher-photos":
      return process.env.NEXT_PUBLIC_TEACHER_PHOTOS_R2_PUBLIC_URL;
    case "teacher-videos":
      return process.env.NEXT_PUBLIC_TEACHER_VIDEOS_R2_PUBLIC_URL;
    default:
      return undefined;
  }
}

export function r2PublicUrl(
  bucket: string,
  path: string | null | undefined,
  version?: number,
): string | null {
  if (!path) return null;
  const base = r2PublicBase(bucket)?.trim().replace(/\/$/, "");
  if (!base) return null;
  const suffix = version ? `?v=${version}` : "";
  return `${base}/${path}${suffix}`;
}
