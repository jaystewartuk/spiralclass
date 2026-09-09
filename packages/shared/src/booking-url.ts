// Builds a teacher's public booking-page URL from a base URL + slug. Every
// call site used to inline `${base}/b/${slug}` independently (web and mobile
// alike) with no guard against a missing/blank slug producing a malformed
// `/b/` URL — this is the one place that logic lives now.
export function bookingPageUrl(baseUrl: string, slug: string | null | undefined): string | null {
  const trimmedSlug = slug?.trim();
  if (!trimmedSlug) return null;
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  return `${trimmedBase}/b/${encodeURIComponent(trimmedSlug)}`;
}
