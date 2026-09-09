// Structural parsing of a help doc's markdown body.
//
// The help centre needs three things the markdown string alone does not give
// it: a table of contents, per-section anchors that survive four docs sharing
// one page, and the question/answer pairs that back the FAQ structured data.
//
// All three are derived here, from the SAME parse, rather than at three call
// sites — the failure mode being avoided is a TOC that links to an anchor the
// renderer never emitted, which looks like a broken page and is invisible to
// every test that only checks the two halves separately.
//
// Deliberately structural (heading LEVEL, paragraph SHAPE) rather than
// keyword-based: docs/help ships an es-MX translation of every file with its
// headings translated too ("## Propósito"), so anything keyed off the English
// word "Purpose" would silently return nothing for half the catalog. Same
// reasoning as scripts/generate-help-content.mjs, which parses the same files.

/** One `##` section of a doc body, with its heading text and everything under
 *  it (including any `###` sub-headings) as raw markdown. */
export interface HelpSection {
  /** The `##` heading text. Empty for content that precedes the first one. */
  heading: string;
  /** Markdown under the heading, heading line excluded. May be empty. */
  body: string;
}

const H2 = /^##\s+(.+?)\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Split a doc body into its `##` sections, in document order.
 *
 * Fence-aware: a `##` inside a code block is content, not a heading. No help
 * doc has one today, which is exactly why it is handled here rather than
 * discovered later by whoever writes the first one.
 */
export function splitHelpSections(markdown: string): HelpSection[] {
  const sections: HelpSection[] = [];
  let current: HelpSection = { heading: "", body: "" };
  let lines: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    current.body = lines.join("\n").trim();
    if (current.heading || current.body) sections.push(current);
    lines = [];
  };

  for (const line of markdown.split("\n")) {
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      if (fence == null) fence = fenceMatch[1];
      else if (line.trimStart().startsWith(fence)) fence = null;
    }

    const heading = fence == null ? line.match(H2) : null;
    if (heading) {
      flush();
      current = { heading: heading[1].trim(), body: "" };
      continue;
    }
    lines.push(line);
  }
  flush();

  return sections;
}

/** A `**Bold lead.** Rest of the paragraph.` entry — the shape every
 *  Questions and Troubleshooting section in docs/help is written in. */
export interface HelpQa {
  /** The bold lead, markdown stripped. */
  question: string;
  /** The remainder of the paragraph, markdown stripped. */
  answer: string;
}

const QA_PARAGRAPH = /^\*\*(.+?)\*\*\s*(.*)$/s;

/**
 * The bold-lead question/answer pairs in a chunk of markdown.
 *
 * Paragraph-scoped rather than line-scoped so a wrapped answer (the source
 * .md files are wrapped at 80 columns) comes back whole instead of truncated
 * at its first newline.
 */
export function parseHelpQa(markdown: string): HelpQa[] {
  const out: HelpQa[] = [];
  for (const paragraph of markdown.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    // A bold lead is only a Q&A when it opens the paragraph AND something
    // follows it; `**Tips**` on its own is a label, not a question.
    const match = trimmed.match(QA_PARAGRAPH);
    if (!match) continue;
    const question = stripMarkdown(match[1]);
    const answer = stripMarkdown(match[2]);
    if (!question || !answer) continue;
    out.push({ question, answer });
  }
  return out;
}

/**
 * Markdown reduced to the words a human reads — for structured data, search
 * haystacks and `<meta>` descriptions, none of which may contain syntax.
 *
 * Link TEXT is kept and the target dropped: `[Stripe's pricing](https://…)`
 * has to read as "Stripe's pricing" in a JSON-LD answer, not as a URL.
 */
export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1$2")
    .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}
