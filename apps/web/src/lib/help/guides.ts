// One parse of the help docs, shared by everything that renders them.
//
// The page needs the guides four ways at once — as prose, as a table of
// contents, as a search index, and as FAQ structured data — and each of those
// wants the same anchor to mean the same section. Deriving them separately is
// how a contents rail ends up linking to an id the article never emitted, so
// they are all derived from this, once, and the ids exist exactly here.

import type { ContentDoc } from "@spiralclass/shared";
import { localize } from "@spiralclass/shared";
import { helpGuideId, helpSectionId } from "./anchors";
import { rewriteHelpDocLinks, type HelpLinkResolver } from "./links";
import { splitHelpSections, stripMarkdown } from "./markdown";

export interface HelpGuideSection {
  /** The anchor id, unique across every guide on the page. */
  id: string;
  heading: string;
  /** Markdown under the heading, cross-references already resolved. */
  body: string;
}

export interface HelpGuide {
  slug: string;
  /** The anchor id of the guide as a whole. */
  id: string;
  title: string;
  summary: string;
  sections: HelpGuideSection[];
}

/**
 * Localize, resolve cross-references, and split each doc into anchored
 * sections.
 *
 * `resolveLink` is how a surface says where a doc-to-doc reference should
 * point on it: the public page holds all four guides at once and answers with
 * an in-page anchor, a single-article page answers with the sibling route, and
 * either may answer `null` for a slug it cannot reach — which unwraps the link
 * and leaves the sentence readable rather than emitting a dead one.
 */
export function prepareHelpGuides(
  docs: readonly ContentDoc[],
  locale: string,
  resolveLink: HelpLinkResolver,
): HelpGuide[] {
  return docs.map((doc) => {
    const body = rewriteHelpDocLinks(localize(doc.body, locale), resolveLink);
    const summary = localize(doc.summary, locale);
    return {
      slug: doc.slug,
      id: helpGuideId(doc.slug),
      title: localize(doc.title, locale),
      summary,
      sections: dropSummaryEcho(
        splitHelpSections(body)
          // Content before the first `##` has no heading to link to and no doc
          // in docs/help has any; dropping it here keeps every section in the
          // contents rail addressable.
          .filter((section) => section.heading.length > 0),
        summary,
      ).map((section, index) => ({
        id: helpSectionId(doc.slug, section.heading, index),
        heading: section.heading,
        body: section.body,
      })),
    };
  });
}

/**
 * Drop a leading section that only repeats the summary.
 *
 * The generator derives `summary` from the first `##` section's first
 * paragraph (scripts/generate-help-content.mjs), so every doc whose opening
 * section is exactly that paragraph — which is all of them, the section is
 * called "Purpose" — renders the same sentence twice in a row: once as the
 * guide's lead, once as its first section, with a heading and a rule between
 * them. It also spent a row in the contents rail on a section that said
 * nothing new.
 *
 * Matched on the TEXT rather than on the heading, because the heading is
 * translated ("Propósito") and because a Purpose section that has grown a
 * second paragraph is no longer an echo and should stay.
 */
function dropSummaryEcho<T extends { body: string }>(sections: T[], summary: string): T[] {
  const [first] = sections;
  if (!first) return sections;
  return stripMarkdown(first.body) === stripMarkdown(summary) ? sections.slice(1) : sections;
}

/** The in-page-anchor resolver: used where every linkable guide is on the
 *  same page. Slugs outside `docs` unwrap rather than link somewhere gated. */
export function anchorLinkResolver(docs: readonly ContentDoc[]): HelpLinkResolver {
  const slugs = new Set(docs.map((doc) => doc.slug));
  return (slug) => (slugs.has(slug) ? `#${helpGuideId(slug)}` : null);
}
