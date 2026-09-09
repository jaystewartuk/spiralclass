// Is a material's FILE attachment a picture? — the one rule behind the inline
// image preview that file-kind materials render instead of a bare "open this"
// link (step 1 of the images-for-visual-learners work).
//
// This is a separate concern from `material-doc/images.ts`: that module is
// about images embedded INSIDE a native-content body, this one is about a
// whole material whose single attachment happens to be an image.
//
// WHY THE FILENAME AND NOT A MIME TYPE. `LibraryMaterial` stores no content
// type — the browser's `file.type` is passed to the storage object at upload
// and never persisted (apps/web/src/lib/storage/materials-upload.ts). The
// stored key is `${prefix}/${Date.now()}-${file.name}`, so the original
// filename, extension included, is the only signal that survives in the
// database. Adding a `mimeType` column would be the stronger fix, but it would
// be null for every material uploaded before it existed — the extension works
// on the whole existing corpus with no migration and no backfill.
//
// SVG IS DELIBERATELY EXCLUDED. An SVG is a document that can carry script and
// external references, not an inert raster; rendering one inline from a
// teacher-uploaded file would reintroduce exactly the HTML sink the material
// renderers are built to avoid (D-17). An uploaded `.svg` therefore stays a
// plain download link — the pre-existing behaviour, not a regression.

/** Raster image extensions a material attachment may be previewed inline as.
 * Matches what every target (a browser `<img>`, react-pdf) can actually
 * decode. */
const IMAGE_FILE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "heic",
  "heif",
]);

/** The lowercase extension of a storage key or filename, without the dot —
 * null when there isn't one. Reads the segment after the LAST dot of the last
 * path segment, so a key like `t/library/1712-my.photo.final.png` resolves to
 * `png` and a dotless name resolves to null. */
export function fileExtensionOf(pathOrName: string): string | null {
  const name = pathOrName.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  // A query string or fragment can ride along when this is handed a URL rather
  // than a storage key (a signed URL always carries one), so both are trimmed
  // before the extension is read.
  return name
    .slice(dot + 1)
    .split(/[?#]/)[0]
    .toLowerCase();
}

/** Does this storage key / filename name a previewable raster image?
 *
 * Safe to call with a null/empty path (a link-kind or content-kind material),
 * which is never an image. */
export function isImageFileName(pathOrName: string | null | undefined): boolean {
  if (!pathOrName) return false;
  const ext = fileExtensionOf(pathOrName);
  return ext !== null && IMAGE_FILE_EXTENSIONS.has(ext);
}

// --- What a whole-file attachment can be shown as, in place -----------------
//
// The in-call viewer replaces the remote participant's video with the
// material, so "open this" has to mean "show it here": a new browser tab takes
// the teacher and the student out of the lesson they are in the middle of.
// Three buckets, because only three behaviours exist — a PDF renders page by
// page, a raster image renders as one picture, and everything else (a .docx, a
// .zip, an .svg — see above) has no in-page renderer and keeps opening
// externally, which is what every file did before.
//
// Filename-derived for the same reason isImageFileName is: there is no
// mimeType column, and the extension works on the whole existing corpus with
// no migration.

/** How a file-kind material's attachment can be displayed by a surface that
 * renders materials in place. `"other"` means "no inline renderer" — the
 * caller falls back to opening it outside the page. */
export type MaterialFileKind = "pdf" | "image" | "other";

/** Does this storage key / filename name a PDF?
 *
 * Safe to call with a null/empty path (a link- or content-kind material),
 * which is never a PDF. */
export function isPdfFileName(pathOrName: string | null | undefined): boolean {
  if (!pathOrName) return false;
  return fileExtensionOf(pathOrName) === "pdf";
}

/** Bucket a file attachment by how it can be displayed. A null/empty path — a
 * link- or content-kind material carries no file at all — is `"other"`: there
 * is nothing to render inline. */
export function materialFileKind(pathOrName: string | null | undefined): MaterialFileKind {
  if (isPdfFileName(pathOrName)) return "pdf";
  if (isImageFileName(pathOrName)) return "image";
  return "other";
}
