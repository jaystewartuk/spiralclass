// Builds a teacher's public booking-page URL from a base URL + slug. Every
// call site used to inline `${base}/b/${slug}` independently (web and mobile
// alike) with no guard against a missing/blank slug producing a malformed
// `/b/` URL — this is the one place that logic lives now.
export function bookingPageUrl(baseUrl: string, slug: string | null | undefined): string | null {
  const trimmedSlug = slug?.trim();
  if (!trimmedSlug) return null;
  // A loop, not `/\/+$/`: that regex retries from every slash in a run that is
  // not at the end, which is quadratic in the run's length.
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === "/") end--;
  const trimmedBase = baseUrl.slice(0, end);
  return `${trimmedBase}/b/${encodeURIComponent(trimmedSlug)}`;
}
