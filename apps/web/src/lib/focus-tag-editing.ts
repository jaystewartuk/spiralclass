// The client-safe half of the focus-tag taxonomy: the caps every editor has to
// respect, and the pure list operations the settings page runs on a keystroke.
//
// Split out of lib/focus-tags.ts because that module reaches for `prisma` and
// `node:crypto` — a "use client" component importing a length cap from it would
// pull the database client into the browser bundle. The caps are DECLARED here
// and re-exported there, so there is still exactly one number per rule: the
// editor's `maxLength` cannot drift from the server validation that rejects it,
// which is the failure mode that made the old page's cap invisible until the
// browser silently stopped accepting characters.

export const FOCUS_TAG_LABEL_MAX_CHARS = 60;
export const FOCUS_TAG_CATEGORY_LABEL_MAX_CHARS = 40;
// Sanity bounds, not plan gates — no Free/Pro cap is defined for this taxonomy
// (unlike students/templates). Just stops a pathological submission from
// writing an unbounded number of rows.
export const FOCUS_TAG_MAX_PER_TEACHER = 300;
export const FOCUS_TAG_CATEGORY_MAX_PER_TEACHER = 60;

/**
 * How many tags it takes before a search field earns its place.
 *
 * A seeded pack is 30-40 tags and the ceiling is 300, so search is the only
 * mechanism that scales — but a search box over eight tags is a control that
 * costs a row of the screen and never gets used. Below this the whole taxonomy
 * fits on one screen and scanning beats typing.
 */
export const FOCUS_TAG_SEARCH_THRESHOLD = 12;

export type FocusTagLike = { id: string; label: string };
export type FocusCategoryLike = { id: string; label: string };
export type FocusGroupLike<C extends FocusCategoryLike, T extends FocusTagLike> = {
  category: C;
  tags: T[];
};

/**
 * The comparison key for "is this the same name?" — trimmed, lowercased and
 * stripped of combining accents, so `Pretérito` and `preterito` collide.
 *
 * Uses the same explicit combining-mark range as `slugifyLabel` in
 * lib/focus-tags.ts rather than a `\p{Diacritic}` class, so the two agree on
 * what an accent is.
 */
export function normalizeFocusLabel(label: string): string {
  return label.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function matchesFocusQuery(label: string, query: string): boolean {
  return normalizeFocusLabel(label).includes(normalizeFocusLabel(query));
}

/**
 * Narrow the grouped taxonomy to what a search matches.
 *
 * A category survives for one of two reasons, and which one changes what it
 * shows. If the CATEGORY's own name matches, the teacher asked for that
 * category and keeps all of its tags — hiding the tags of a category she
 * searched for by name would be an empty answer to a direct question. If only
 * some of its TAGS match, it shows exactly those.
 *
 * `matches` counts both kinds, so a category-name hit with no tags under it
 * still reports one result rather than reading "0 matches" beside a visible
 * card.
 */
export function filterFocusGroups<C extends FocusCategoryLike, T extends FocusTagLike>(
  groups: FocusGroupLike<C, T>[],
  query: string,
): { groups: FocusGroupLike<C, T>[]; matches: number } {
  if (!normalizeFocusLabel(query)) {
    return { groups, matches: groups.reduce((n, group) => n + group.tags.length, 0) };
  }

  let matches = 0;
  const out: FocusGroupLike<C, T>[] = [];
  for (const group of groups) {
    const categoryMatches = matchesFocusQuery(group.category.label, query);
    const tags = categoryMatches
      ? group.tags
      : group.tags.filter((tag) => matchesFocusQuery(tag.label, query));
    if (!categoryMatches && tags.length === 0) continue;
    matches += tags.length + (categoryMatches ? 1 : 0);
    out.push(categoryMatches ? group : { category: group.category, tags });
  }
  return { groups: out, matches };
}

/**
 * Whether `label` is already taken among `siblings`, ignoring the row being
 * edited. Duplicates are legal — the server accepts them — so this drives a
 * warning, never a block: two tags called "Ser vs estar" in the same category
 * are almost certainly a mistake, but they are the teacher's mistake to make.
 */
export function isDuplicateFocusLabel(
  label: string,
  siblings: FocusTagLike[],
  ignoreId?: string,
): boolean {
  const key = normalizeFocusLabel(label);
  if (!key) return false;
  return siblings.some(
    (sibling) => sibling.id !== ignoreId && normalizeFocusLabel(sibling.label) === key,
  );
}
