import { listContentDocs, type ContentAudience } from "@spiralclass/shared";
import { prepareHelpGuides } from "@/lib/help/guides";
import { buildHelpSearchEntries } from "@/lib/help/search";
import type { SearchEntry } from "./match";

// The help centre's articles, as site-search entries.
//
// Built from the same parse the article pages render (prepareHelpGuides →
// buildHelpSearchEntries), so every result's anchor is an id the article page
// actually emits — a section heading or a bold-lead question inside one, the
// actual questions the docs answer. Cross-references are unwrapped rather than
// resolved: a snippet is plain text, and nothing in it is a link.

export function helpSearchEntries(audience: ContentAudience, locale: string): SearchEntry[] {
  const guides = prepareHelpGuides(listContentDocs(audience), locale, () => null);
  return guides.flatMap((guide) => {
    const articleHref = `/help/${audience}/${guide.slug}`;
    return buildHelpSearchEntries([guide]).map((entry, index) => ({
      id: `help.${guide.slug}.${index}`,
      kind: "help" as const,
      label: entry.label,
      detail: entry.context || entry.snippet || undefined,
      href: entry.kind === "guide" ? articleHref : `${articleHref}#${entry.id}`,
      terms: entry.snippet,
    }));
  });
}
