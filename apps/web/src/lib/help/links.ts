// Rewrite the cross-references inside a help doc body.
//
// docs/help/**/*.md is a contributor-facing docs tree first, so its articles
// link to each other the way markdown files do — `[Create packages and manage
// payments](packages-and-payments.md)`. The generator
// (scripts/generate-help-content.mjs) strips the trailing "Related articles"
// list but not the inline ones, so those relative targets reach the renderer
// intact and `<a href="packages-and-payments.md">` resolves against whatever
// path the reader is on. On /help that is a 404, on
// /help/teacher/settings-and-subscription it is a different 404, and neither
// looks like a bug until someone clicks it. One such link is live on the
// public FAQ today.
//
// The fix is per-surface rather than in the generator, because the right
// target genuinely differs: the public page holds all four guides at once and
// wants an in-page anchor, the gated pages want the sibling route, and a
// surface with no destination at all wants the sentence to still read.

/** Where a doc slug should point on the surface doing the rendering. Return
 *  `null` to unwrap the link and leave its text — always safe, never dead. */
export type HelpLinkResolver = (slug: string) => string | null;

// `[text](slug.md)` / `[text](slug.es-MX.md)` — a bare relative filename, no
// scheme and no directory. Absolute links (stripe.com/pricing) and anything
// already pointing at a route are left exactly as they are.
const RELATIVE_DOC_LINK = /\[([^\]]+)\]\((?!\w+:)(?!\/)([a-z0-9-]+)(?:\.[a-zA-Z-]+)?\.md\)/g;

/**
 * Point every in-tree `.md` cross-reference at a real destination, or unwrap
 * it. The returned markdown contains no relative `.md` link either way, which
 * is the property the guard test asserts.
 */
export function rewriteHelpDocLinks(markdown: string, resolve: HelpLinkResolver): string {
  return markdown.replace(RELATIVE_DOC_LINK, (_match, text: string, slug: string) => {
    const href = resolve(slug);
    return href ? `[${text}](${href})` : text;
  });
}
