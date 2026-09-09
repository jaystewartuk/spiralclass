import type { MaterialBlock, MaterialDoc } from "./types";

// Everything the four surfaces need to agree on about a material image: how an
// image reference is spelled inside a body, which references are safe to load,
// and where an uploaded image's bytes live.
//
// WHY A CUSTOM SCHEME rather than storing a URL. An uploaded material image is
// a private object in the class-materials bucket, reachable only through a
// short-lived signed URL — a URL that would be stale days before the body that
// embeds it is next read. The body therefore stores the STORAGE KEY behind the
// `material-image:` scheme, and each platform turns that into a URL it can
// actually fetch at render time (web: a same-origin route on the session
// cookie; mobile: the same route under /api/mobile on the bearer token). The
// stored body stays valid forever, and no signed URL is ever persisted.
//
// EXTERNAL IMAGES are allowed but restricted to https. An http image would be
// blocked as mixed content anyway, and every other scheme (data:, blob:,
// file:, javascript:) is either a rendering-engine attack surface or useless
// here — the same allow-list discipline the renderers already apply to link
// hrefs (the D-17 boundary).
//
// PRIVACY NOTE for external images: unlike a link, an <img> is fetched the
// moment the document renders, so an external src silently reports the
// student's IP and user-agent to that host. That is the reason the editors
// only ever WRITE the `material-image:` form — uploading a copy — while
// external https srcs are still READ, so an AI- or hand-authored body that
// already carries one keeps working.

/** The scheme an uploaded material image is referenced by inside a body. */
export const MATERIAL_IMAGE_SCHEME = "material-image:";

/** Image content types accepted on upload, mapped to the extension the stored
 * object gets. Kept in step with the web upload route + the mobile picker;
 * anything outside this table is rejected before a byte is written. */
export const MATERIAL_IMAGE_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Upload cap for a material image. Smaller than the 25 MB generic material
 * file cap: this is an illustration inside a document that a student may load
 * over mobile data, several at a time, not a downloadable resource. */
export const MAX_MATERIAL_IMAGE_BYTES = 8 * 1024 * 1024;

/** The extension a given upload content type is stored under, or null if the
 * type isn't an accepted image. */
export function materialImageExtension(contentType: string): string | null {
  return MATERIAL_IMAGE_CONTENT_TYPES[contentType.trim().toLowerCase()] ?? null;
}

/** Where an uploaded material image lives in the class-materials bucket.
 *
 * The `library/` segment is load-bearing: the time-based per-class purge job
 * (apps/web/src/lib/storage/materials-purge.ts) deletes old booking-scoped
 * objects but explicitly skips this prefix, so an image embedded in a reusable
 * library material is never swept out from under the body that references it.
 *
 * `unique` is caller-supplied (a timestamp + random suffix) rather than
 * generated here so this module stays pure and deterministic — the same reason
 * the parser and serializer take no ambient state. */
export function materialImageStoragePath(
  teacherId: string,
  unique: string,
  extension: string,
): string {
  return `${teacherId}/library/images/${unique}.${extension}`;
}

/** The teacher a stored image key belongs to — the first path segment written
 * by `materialImageStoragePath`. Returns null for a key that isn't shaped like
 * a material image path at all, so a caller can reject it rather than run an
 * ownership check against `undefined`. */
export function materialImageOwner(key: string): string | null {
  const parts = key.split("/");
  if (parts.length < 4) return null;
  if (parts[1] !== "library" || parts[2] !== "images") return null;
  return parts[0] || null;
}

/** A body `src` written as `material-image:<key>`, unwrapped to its storage
 * key — or null if it isn't one. Rejects a key that escapes its prefix (`..`,
 * a leading slash, a backslash) so a hand-edited body can never address an
 * object outside the images tree. */
export function materialImageKey(src: string): string | null {
  const trimmed = src.trim();
  if (!trimmed.toLowerCase().startsWith(MATERIAL_IMAGE_SCHEME)) return null;
  const key = trimmed.slice(MATERIAL_IMAGE_SCHEME.length);
  if (!key || key.startsWith("/") || key.includes("..") || key.includes("\\")) return null;
  return key;
}

/** Spell a storage key as the `src` a body stores. */
export function materialImageSrc(key: string): string {
  return `${MATERIAL_IMAGE_SCHEME}${key}`;
}

/** The route an embedded image is served from.
 *
 * It took a `surface: "web" | "mobile"` while a bearer-authed sibling route
 * existed under /api/mobile; D-163 deleted that route, so there is one path.
 *
 * Each key segment is encoded individually: `encodeURI` would leave a `?` or
 * `#` inside a key intact and truncate the path at it. */
export function materialImageRoutePath(key: string): string {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `/api/materials/images/${encoded}`;
}

/** What a renderer should do with an image block's `src`.
 *
 *  - `stored`   — an uploaded image; the renderer builds its own platform URL
 *                 from `key` (a route that authenticates, then redirects to a
 *                 freshly-signed object URL).
 *  - `external` — a plain https URL, used as-is.
 *  - `null`     — anything else (http, data:, javascript:, a malformed
 *                 reference). The renderers show the alt text instead of
 *                 loading it, exactly as they do for a disallowed link scheme.
 */
export type MaterialImageRef = { kind: "stored"; key: string } | { kind: "external"; url: string };

export function resolveMaterialImageSrc(src: string): MaterialImageRef | null {
  const key = materialImageKey(src);
  if (key) return { kind: "stored", key };
  const trimmed = src.trim();
  if (/^https:\/\/\S+$/i.test(trimmed)) return { kind: "external", url: trimmed };
  return null;
}

/** Strip the characters that would break an image out of its own `![…](…)`
 * spelling on the next reparse. The parser reads an alt as `[^\]]*` on one
 * line, so a `]` or a newline in author-typed alt text would truncate or split
 * the block; the same reasoning as `singleLine` in ./block-editor.ts. */
export function sanitizeImageAlt(alt: string): string {
  return alt.replace(/\s*[\r\n]+\s*/g, " ").replace(/[[\]]/g, "");
}

/** Strip whitespace and parens out of a `src` for the same reason — the
 * parser reads it as `[^)\s]+`. A src that is empty afterwards is not
 * representable and callers must treat it as "no image". */
export function sanitizeImageSrc(src: string): string {
  return src.trim().replace(/[\s()]/g, "");
}

/** Every stored-image key referenced anywhere in a document, at any nesting
 * depth, de-duplicated in first-encounter order.
 *
 * This is what makes an embedded image's lifetime accountable: hard-deleting a
 * material frees the objects its body referenced (apps/web/src/lib/storage/
 * material-images.ts), which archiving deliberately does not. External srcs
 * are not included — nothing here owns them. */
export function collectMaterialImageKeys(doc: MaterialDoc | MaterialBlock[]): string[] {
  const blocks = Array.isArray(doc) ? doc : doc.blocks;
  const keys: string[] = [];
  const seen = new Set<string>();
  const walk = (list: MaterialBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "image": {
          const key = materialImageKey(block.src);
          if (key && !seen.has(key)) {
            seen.add(key);
            keys.push(key);
          }
          break;
        }
        case "callout":
        case "quote":
          walk(block.blocks);
          break;
        case "list":
          for (const item of block.items) walk(item.children);
          break;
        default:
          break;
      }
    }
  };
  walk(blocks);
  return keys;
}
