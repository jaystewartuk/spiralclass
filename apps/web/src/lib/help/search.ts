// The public help centre's search index, and the matcher over it.
//
// WHY AN INDEX RATHER THAN A FILTER OVER THE PAGE. The four public guides are
// rendered in full, one after another — roughly fourteen thousand characters
// of prose. A reader who arrives knowing her question ("why is the payment
// less than the price I set?") should not have to find it by scrolling, and
// the browser's own Ctrl-F only matches text she has already guessed the
// wording of. So the page indexes what it renders — every guide, every
// section, and every bold-lead question inside them — and search jumps to the
// anchor rather than filtering the article away.
//
// It is built on the server from the same docs the sections below render, so
// a result can never point at something the page does not contain.

import type { HelpGuide } from "./guides";
import { parseHelpQa, stripMarkdown } from "./markdown";

/** What kind of thing a result points at — the UI labels each differently, so
 *  a reader can tell "a whole guide" from "one answer inside one". */
export type HelpEntryKind = "guide" | "section" | "question";

export interface HelpSearchEntry {
  /** The anchor this result scrolls to, without the `#`. */
  id: string;
  kind: HelpEntryKind;
  /** The result's own line — a guide title, a section heading, a question. */
  label: string;
  /** Where it sits: the guide title, for a result that is not the guide. */
  context: string;
  /** The sentence shown under the label. Empty when there is nothing to add. */
  snippet: string;
  /** Everything the matcher searches, pre-normalised. Never displayed. */
  haystack: string;
}

// A snippet is a hint, not the answer: long enough to confirm the result is
// the right one, short enough that eight of them still scan as a list.
const SNIPPET_MAX = 140;

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function truncate(text: string): string {
  if (text.length <= SNIPPET_MAX) return text;
  const cut = text.slice(0, SNIPPET_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : SNIPPET_MAX).trimEnd()}…`;
}

function entry(input: Omit<HelpSearchEntry, "haystack"> & { extra?: string }): HelpSearchEntry {
  const { extra, ...rest } = input;
  return {
    ...rest,
    haystack: normalize([rest.label, rest.context, rest.snippet, extra ?? ""].join(" ")),
  };
}

/**
 * Flatten the prepared guides into one searchable list, in page order.
 *
 * A guide contributes three tiers of entry: itself, each of its `##` sections,
 * and each bold-lead question inside those sections. The question tier is the
 * one that earns the feature — those are the actual questions the docs answer,
 * and none of them is reachable from a heading.
 *
 * It takes the PREPARED guides rather than the raw docs so a result's anchor
 * is the very object the page rendered, not a second computation of it.
 */
export function buildHelpSearchEntries(guides: readonly HelpGuide[]): HelpSearchEntry[] {
  const entries: HelpSearchEntry[] = [];

  for (const guide of guides) {
    entries.push(
      entry({
        id: guide.id,
        kind: "guide",
        label: guide.title,
        context: "",
        snippet: truncate(stripMarkdown(guide.summary)),
      }),
    );

    for (const section of guide.sections) {
      entries.push(
        entry({
          id: section.id,
          kind: "section",
          label: section.heading,
          context: guide.title,
          // A section's own lead paragraph, if it has prose before its first
          // Q&A or list. Falls back to nothing rather than to the first
          // bullet, which reads as a fragment out of context.
          snippet: truncate(stripMarkdown(section.body.split(/\n{2,}/)[0] ?? "")),
          // Sub-headings are searchable through their section even though
          // they get no anchor of their own — "Connect or disconnect Google
          // Calendar" should find the section that explains it.
          extra: section.body
            .split("\n")
            .filter((line) => line.startsWith("###"))
            .join(" "),
        }),
      );

      for (const item of parseHelpQa(section.body)) {
        entries.push(
          entry({
            id: section.id,
            kind: "question",
            label: item.question,
            context: guide.title,
            snippet: truncate(item.answer),
          }),
        );
      }
    }
  }

  return entries;
}

// A result list longer than this stops being a shortlist and becomes another
// thing to read.
const DEFAULT_LIMIT = 8;

// Rank by what the reader most likely meant. A question that starts with the
// words she typed beats a guide that merely mentions them somewhere.
const KIND_RANK: Record<HelpEntryKind, number> = { question: 0, guide: 1, section: 2 };

/**
 * Every entry matching all the words in `query`, best first.
 *
 * AND across terms, substring within one — "package expire" finds the answer
 * whose question is "When does a package expire?" without the reader having
 * to guess the exact phrasing, while a second word still narrows rather than
 * widens. Ranking is by where the match landed (a label beats a snippet), then
 * by kind, then by page order, which is what makes the list stable as she
 * types rather than reshuffling under the cursor.
 */
export function searchHelpEntries(
  entries: readonly HelpSearchEntry[],
  query: string,
  limit: number = DEFAULT_LIMIT,
): HelpSearchEntry[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored: Array<{ entry: HelpSearchEntry; score: number; order: number }> = [];

  entries.forEach((item, order) => {
    if (!terms.every((term) => item.haystack.includes(term))) return;
    const label = normalize(item.label);
    const score = terms.every((term) => label.startsWith(term))
      ? 0
      : terms.every((term) => label.includes(term))
        ? 1
        : 2;
    scored.push({ entry: item, score, order });
  });

  scored.sort(
    (a, b) =>
      a.score - b.score || KIND_RANK[a.entry.kind] - KIND_RANK[b.entry.kind] || a.order - b.order,
  );

  return scored.slice(0, limit).map((s) => s.entry);
}
