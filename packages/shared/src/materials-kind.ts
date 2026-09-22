// What KIND of thing one library material is — the single definition of a rule
// that had been written out three times.
//
// A material row can carry a body, a file and a link at once, so "which one is
// it?" is a PRECEDENCE, not a column: a body wins, then a file, then a link.
// That order was already fixed by `typeWhere` in the web read layer
// (apps/web/src/lib/library/library-queries.ts), which is what the `?type=`
// filter queries against — but the renderers each re-derived it inline, so the
// icon a row showed and the chip that matched it were two independent copies of
// the same three-way `if`. This is the copy both sides read.
//
// It lives in `shared` rather than in the web app because the same three
// buckets are what the `?type=` filter offers on every surface, and a renderer
// that disagreed with the filter would show a row under a chip that does not
// describe it.

/** The three buckets a material falls into, in precedence order. */
export type MaterialKind = "written" | "file" | "link";

/** The subset of a material row this rule reads. Accepts the wire shape and
 * the Prisma row alike — both carry these three nullable columns. */
export type MaterialKindInput = {
  body?: string | null;
  storagePath?: string | null;
  linkUrl?: string | null;
};

/**
 * Which bucket a material falls into.
 *
 * A row with none of the three is `"link"` — the same bucket `typeWhere("link")`
 * puts it in (`body: null, storagePath: null`), so a degenerate row stays
 * findable under the chip that matches it rather than becoming a fourth,
 * unfilterable kind.
 */
export function materialKindOf(material: MaterialKindInput): MaterialKind {
  if (material.body) return "written";
  if (material.storagePath) return "file";
  return "link";
}
