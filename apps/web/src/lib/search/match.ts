// The matcher behind the site-wide search (docs/features/search.md).
//
// One index per signed-in person, three sources in it: the pages and actions
// of her side of the product (built in the browser from the nav registries),
// her own records (fetched once per open from /api/{teacher,student}/search),
// and the help articles for her audience. This file only ranks; it knows
// nothing about where an entry came from.
//
// WHY IN MEMORY, NOT A DATABASE QUERY PER KEYSTROKE. The same reason the
// roster, the lead list and the class list search in memory: Postgres `ILIKE`
// folds case and nothing else, so "lopez" never finds "López" — silently. A
// teacher's whole index is a few hundred short strings; folding them once and
// filtering on every keystroke is instant and needs no round trip.

import { foldForSearch } from "@/lib/students-list";

/** What a result points at. The UI labels and icons each differently. */
export type SearchKind =
  "page" | "action" | "student" | "teacher" | "class" | "package" | "lead" | "material" | "help";

/** One searchable thing. Serializable — records arrive in this shape as JSON. */
export type SearchEntry = {
  /** Unique within one index. */
  id: string;
  kind: SearchKind;
  /** The result's own line. */
  label: string;
  /** The line under it: a date, an email, where a help answer lives. */
  detail?: string;
  href: string;
  /** Searched but never displayed: synonyms, the label in other languages. */
  terms?: string;
  /** Opens outside the app shell (the public booking page, legal pages). */
  external?: boolean;
  /** An archived student or lead — still findable, marked as such. */
  archived?: boolean;
};

export type IndexedEntry<E extends SearchEntry = SearchEntry> = {
  entry: E;
  label: string;
  haystack: string;
  order: number;
};

/** Fold every entry once, so a keystroke only compares strings. */
export function indexSearchEntries<E extends SearchEntry>(
  entries: readonly E[],
): IndexedEntry<E>[] {
  return entries.map((entry, order) => ({
    entry,
    label: foldForSearch(entry.label),
    haystack: foldForSearch([entry.label, entry.detail ?? "", entry.terms ?? ""].join(" ")),
    order,
  }));
}

// Pages first on a tie: "packages" should land on the Packages page before a
// package template happens to be called "Packages for two". A person's name
// beats a class with that person, which beats an answer in the help centre.
const KIND_RANK: Record<SearchKind, number> = {
  page: 0,
  action: 1,
  student: 2,
  teacher: 2,
  package: 3,
  class: 4,
  lead: 5,
  material: 5,
  help: 6,
};

// A result list longer than this stops being a shortlist.
export const DEFAULT_RESULT_LIMIT = 12;

// No single kind may crowd the others out: a teacher typing "ana" wants Ana,
// Ana's next class and Ana's lead — not eleven of Ana's classes.
export const PER_KIND_LIMIT: Record<SearchKind, number> = {
  page: 6,
  action: 4,
  student: 5,
  teacher: 5,
  package: 3,
  class: 4,
  lead: 3,
  material: 3,
  help: 4,
};

// Words people type around what they mean — "where is my packet", "plan the
// day", "¿dónde están mis paquetes?". Under AND matching each one would have
// to appear in the entry, so a natural question would find nothing. Dropped
// from the query unless it is all there is. Folded, like everything compared.
const FILLER_WORDS: ReadonlySet<string> = new Set([
  // en
  ...["a", "an", "the", "my", "to", "of", "for", "in", "on", "at", "is", "are"],
  ...["where", "how", "do", "i", "me", "can", "what", "page", "find", "see"],
  // es
  ...["el", "la", "los", "las", "un", "una", "de", "del", "mi", "mis", "en", "al"],
  ...["donde", "esta", "estan", "como", "que", "para", "pagina", "ver", "encontrar"],
  // fr
  ...["le", "les", "une", "des", "du", "mon", "ma", "mes", "ou", "est", "sont"],
  ...["comment", "pour", "voir", "trouver", "je"],
]);

/** The words of `query` that carry meaning, folded. */
export function queryTerms(query: string): string[] {
  const words = foldForSearch(query)
    // Punctuation is not something anyone means: "¿dónde?" is "donde".
    .replace(/[^\p{L}\p{N}@.+\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = words.filter((word) => !FILLER_WORDS.has(word));
  return meaningful.length > 0 ? meaningful : words;
}

/**
 * `query` without its filler words, spelled as she typed it. For handing a
 * query to a page that searches by substring: "where is Marco López" must reach
 * the roster as "Marco López" (accents intact, for a server-side filter that
 * does not fold them), not as the whole sentence, which matches nothing.
 */
export function meaningfulQuery(query: string): string {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const kept = words.filter((word) => {
    const folded = queryTerms(word);
    return !(folded.length === 1 && FILLER_WORDS.has(folded[0] ?? ""));
  });
  return (kept.length > 0 ? kept : words).join(" ").replace(/[¿?¡!]/g, "");
}

function wordStarts(label: string, term: string): boolean {
  return label.startsWith(term) || label.includes(` ${term}`);
}

/**
 * Every entry matching all the words in `query`, best first.
 *
 * AND across words, substring within one, accents and case folded — "plan
 * dia" finds "Plan de día", "lopez" finds "López" — with filler words ignored
 * ("plan the day" is "plan day"). Ranking is by where the
 * match landed (the label's start, a word in the label, anywhere in the label,
 * only in the hidden terms), then by kind, then by index order, so the list
 * is stable as she types rather than reshuffling under the cursor.
 */
export function searchEntries<E extends SearchEntry>(
  index: readonly IndexedEntry<E>[],
  query: string,
  limit: number = DEFAULT_RESULT_LIMIT,
): E[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  // What she typed, filler and all, for the "label starts with it" tier:
  // "plan de dia" should rank "Plan de día" as exactly what she meant.
  const typed = foldForSearch(query).trim().replace(/\s+/g, " ");

  const scored: Array<{ item: IndexedEntry<E>; score: number }> = [];
  for (const item of index) {
    if (!terms.every((term) => item.haystack.includes(term))) continue;
    const score = item.label.startsWith(typed)
      ? 0
      : terms.every((term) => wordStarts(item.label, term))
        ? 1
        : terms.every((term) => item.label.includes(term))
          ? 2
          : 3;
    scored.push({ item, score });
  }

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      KIND_RANK[a.item.entry.kind] - KIND_RANK[b.item.entry.kind] ||
      a.item.order - b.item.order,
  );

  const perKind = new Map<SearchKind, number>();
  const results: E[] = [];
  for (const { item } of scored) {
    const kind = item.entry.kind;
    const seen = perKind.get(kind) ?? 0;
    if (seen >= PER_KIND_LIMIT[kind]) continue;
    perKind.set(kind, seen + 1);
    results.push(item.entry);
    if (results.length >= limit) break;
  }
  return results;
}
