import { NextResponse } from "next/server";
import { canViewMaterialImage, type ImageViewer } from "@/lib/materials/image-access";
import { getStorageProvider } from "@/lib/storage/provider";
import { mintMaterialsSignedUrl } from "@/lib/storage/signed-urls";

// The body of the embedded-image route: everything after the viewer is
// identified — the access check, the not-found discipline, the signed redirect
// and its cache headers.
//
// It was split out because there were TWO such routes (a session-cookie web one
// and a bearer-token one) and they must not answer the same request
// differently. The second is removed. Kept split anyway: the access rules
// below are the interesting half and are worth testing without a route around
// them.

/** Rebuild the storage key from a catch-all route's path segments. Each
 * segment is decoded individually — the URL builder encoded them that way so a
 * `?`/`#` inside a key could never truncate it. */
export function imageKeyFromSegments(segments: string[]): string {
  return segments.map(decodeURIComponent).join("/");
}

/** Authorize, then redirect to a freshly-signed object URL.
 *
 * Every failure is a 404, never a 403: distinguishing "not yours" from "not
 * there" would let a caller confirm which images exist by probing keys. Same
 * rule the material PDF route already follows. */
export async function serveMaterialImage(
  key: string,
  viewer: ImageViewer | null,
): Promise<Response> {
  if (!viewer || !(await canViewMaterialImage(key, viewer))) {
    return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });
  }

  const signed = await mintMaterialsSignedUrl(getStorageProvider(), key);
  if (!signed) {
    return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });
  }

  // The redirect itself must never be cached or shared: it carries a
  // short-lived signed URL, and the next viewer has to be authorized again.
  // The signed target it points at is what the client actually caches.
  return NextResponse.redirect(signed, {
    status: 302,
    headers: { "Cache-Control": "private, max-age=0, must-revalidate" },
  });
}
