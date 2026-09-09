// The in-app help-docs content model — shared by web and mobile so both
// platforms render the exact same audience-segmented documentation. Content
// is generated from docs/help/{teacher,student}/*.md (see
// scripts/generate-help-content.mjs) — docs/help is the single source of
// truth; do not hand-edit generated.ts.
//
// Bodies are plain markdown strings baked into a checked-in .ts module, not
// read from .md at runtime: packages/shared has no build step (apps consume
// ./src/*.ts directly via the workspace symlink), and Metro has no loader
// for raw .md.
//
// `en` is required (docs/help/**/<slug>.md); `es-MX` is optional, sourced
// from a sibling docs/help/**/<slug>.es-MX.md when one exists. There is no
// `fr` variant yet — `localize()` falls back to `en` for any locale without
// its own translation.

export const CONTENT_AUDIENCES = ["teacher", "student", "admin"] as const;
export type ContentAudience = (typeof CONTENT_AUDIENCES)[number];

export interface LocalizedText {
  en: string;
  "es-MX"?: string;
}

export interface ContentDoc {
  /** Unique within its audience; used as the URL segment on both platforms. */
  slug: string;
  audience: ContentAudience;
  title: LocalizedText;
  /** One-line summary — used in doc-list rows and as the FAQPage JSON-LD answer. */
  summary: LocalizedText;
  /** Markdown body, rendered by MarkdownArticle (web) / ClassContentMarkdown (mobile). */
  body: LocalizedText;
  /** Also surfaced on the public, unauthenticated /help FAQ (web) and the
   * signed-out mobile help list. Reserved for content that's useful before
   * signup — never true for the admin audience (no admin docs exist yet). */
  publicFaq?: boolean;
}

/** Resolve a LocalizedText for the given app locale, falling back to `en`
 *  when the locale has no translation (e.g. `fr`, or `es-MX` before it's
 *  written for a given doc). */
export function localize(text: LocalizedText, locale: string): string {
  if (locale === "es-MX" && text["es-MX"]) return text["es-MX"];
  return text.en;
}
