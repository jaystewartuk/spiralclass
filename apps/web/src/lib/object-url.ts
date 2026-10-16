// Object URLs for files the viewer picks.
//
// `URL.createObjectURL` turns any Blob into a `blob:` URL in this origin, served
// back with the Blob's own type — and a picked file's type is read off its file
// extension, so it says whatever the file's name says. An <img> or <video>
// decodes its source as media and never runs script from it, but the same URL
// opened directly (a preview's "Open image in new tab") is a document in this
// origin, and an SVG or HTML document can carry script. So a picked file gets a
// URL only when its type is inert media the caller expects: the allowlist at
// each call site is what decides what a picked file can ever be served as here.

/**
 * An object URL for `file`, or null when its type is not one of `allowed`
 * (exact, lowercase MIME types). The caller owns revoking the URL.
 */
export function mediaObjectUrl(file: Blob, allowed: readonly string[]): string | null {
  if (!allowed.includes(file.type)) return null;
  return URL.createObjectURL(file);
}
