// Anchor ids for the public help centre.
//
// Four guides share one page, and every one of them has a section called
// "Purpose" and a section called "Tips". So an id derived from the heading
// alone collides four ways, and a reader following a deep link lands on
// whichever one the browser found first. Every id is therefore namespaced by
// its doc slug, which is already unique within an audience.
//
// The ids are computed HERE and used by both the table of contents and the
// rendered section, so a link and its target cannot be generated from two
// different rules.

const NON_WORD = /[^a-z0-9]+/g;

/**
 * A heading reduced to an URL fragment.
 *
 * Diacritics are folded rather than dropped: the es-MX docs head their
 * sections "Propósito" and "Solución de problemas", and stripping the accented
 * character outright would give "prop-sito" — a fragment that still works but
 * reads as a typo to anyone who looks at the address bar.
 */
export function slugifyAnchor(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(NON_WORD, "-")
    .replace(/^-+|-+$/g, "");
}

/** The id of a guide's own section — the target of a TOC's top-level link. */
export function helpGuideId(docSlug: string): string {
  return `guide-${docSlug}`;
}

/** The id of one `##` section inside a guide. Namespaced by the guide so the
 *  "Purpose" heading each of the four guides carries stays four distinct
 *  targets. Headings that slugify to nothing (a heading of pure punctuation)
 *  fall back to their position, which is stable for a given document. */
export function helpSectionId(docSlug: string, heading: string, index: number): string {
  const slug = slugifyAnchor(heading);
  return `${helpGuideId(docSlug)}-${slug || `section-${index + 1}`}`;
}
