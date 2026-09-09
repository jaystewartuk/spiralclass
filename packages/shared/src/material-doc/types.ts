// The canonical semantic document model for AI-generated class materials.
//
// WHY THIS EXISTS (the material-rendering redesign): materials used to be a
// flat Markdown string that FIVE renderers each re-parsed and re-styled
// independently (web on-screen, web PDF, mobile, plus the docs/help copies) —
// they drifted, and none could tell a "vocabulary" box from a "warning" from a
// plain paragraph, so every material rendered as undifferentiated prose. This
// module is the single intermediate representation those renderers now share: a
// material `body` (still Markdown on the wire — see parse.ts for why) is parsed
// ONCE, here, into a typed block tree, and each platform renderer walks that
// tree mapping block types to its own styled primitives. One parser + one token
// set (packages/shared/src/tokens.ts) = the renderers cannot semantically drift.
//
// The model is deliberately renderer-agnostic: no colours, no fonts, no
// className/StyleSheet — only *what the content is*. How each block looks is the
// renderer's job. Adding a new content type = add a variant here + a case in
// each renderer, never a schema/DB change (the wire format stays Markdown).

/** A parsed inline run. Inline is parsed once here so no renderer re-implements
 * bold/italic/code/link scanning — the historical source of drift. */
export type InlineNode =
  | { type: "text"; value: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: InlineNode[] };

/** Column alignment parsed from a GFM table's separator row (`:--`, `:-:`,
 * `--:`). `null` = default (left) alignment for that column. */
export type ColumnAlign = "left" | "center" | "right" | null;

/** One item in a list. `checked` is non-null only for a GFM task-list item
 * (`- [ ]` / `- [x]`) — it drives the checklist rendering; ordinary bullets and
 * numbers leave it null. `blocks` lets an item hold nested paragraphs/lists so
 * multi-line exercise steps survive. */
export type ListItem = {
  inlines: InlineNode[];
  checked: boolean | null;
  children: MaterialBlock[];
};

/** The semantic callout kinds a material can contain. Each maps (in
 * ./callouts.ts) to a colour role + icon + localized label so every renderer
 * presents it identically. This list is the extension point: a future
 * AI-authored block type is one entry here + one row in CALLOUT_META. */
export const CALLOUT_VARIANTS = [
  "note",
  "info",
  "tip",
  "important",
  "warning",
  "remember",
  "example",
  "exercise",
  "question",
  "answer",
  "vocabulary",
  "grammar",
  "summary",
  "homework",
] as const;

export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];

/** A block-level node. The tree is intentionally shallow — headings are flat
 * (not nested sections) so streaming/partial parses always yield a valid doc. */
export type MaterialBlock =
  | { type: "heading"; level: 1 | 2 | 3; inlines: InlineNode[] }
  | { type: "paragraph"; inlines: InlineNode[] }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | {
      // A semantic callout (`> [!tip] optional title`). `title` is the
      // author-supplied heading text (null → the renderer shows the variant's
      // localized default label); `blocks` is the recursively-parsed body.
      type: "callout";
      variant: CalloutVariant;
      title: InlineNode[] | null;
      blocks: MaterialBlock[];
    }
  | { type: "quote"; blocks: MaterialBlock[] }
  | { type: "code"; text: string; lang: string | null }
  | { type: "table"; header: InlineNode[][]; rows: InlineNode[][][]; align: ColumnAlign[] }
  | {
      // A standalone image (`![alt](src)` alone on a line) — the visual half of
      // a material, for the dual-coding a language learner gets from a picture
      // beside the word. BLOCK-LEVEL ONLY, deliberately: an image inside a
      // sentence has no useful rendering in a lesson document, and keeping it
      // out of InlineNode means the three renderers never have to place an
      // image inside a <Text>/<p> run.
      //
      // `alt` doubles as the caption every renderer prints under the image, so
      // it is never decorative-empty in practice; `src` is either an uploaded
      // material image (the `material-image:` scheme — see ./images.ts) or an
      // external https URL. Each renderer resolves and allow-lists `src`
      // through ./images.ts at its own sink, exactly as it already does for
      // link hrefs.
      type: "image";
      src: string;
      alt: string;
    }
  | TimelineBlock
  | { type: "divider" };

/** One event marker on a tense timeline. `at` is an integer 0–100 across the
 * axis (50 = the present); `label` is plain text — never inline markup, because
 * it is drawn beside a graphic on three surfaces that would each have to lay
 * out a styled run inside it. */
export type TimelinePoint = { at: number; label: string };

/** The one highlighted range on a tense timeline — "have lived here", the
 * stretch of time the tense being taught actually covers. `from <= to` always
 * (the parser orders them). */
export type TimelineSpan = { from: number; to: number; label: string };

/** A tense timeline: past/present/future on a line, with markers and a
 * highlighted span — the graphic a teacher draws on a whiteboard to
 * teach a tense, and the first block type that is DRAWN rather than typeset.
 *
 * It is pure data by construction: positions and plain-text labels, from which
 * each platform's own components produce the drawing. No markup a renderer
 * evaluates ever crosses this boundary — see
 * docs/architecture/material-visuals.md, "no markup sink" (D-17), and
 * ./timeline.ts for the Markdown spelling and the shared geometry every
 * renderer draws from. */
export type TimelineBlock = {
  type: "timeline";
  /** The axis chrome, as DATA rather than localized chrome: the PDF has no
   * i18n runtime, and a teacher must be able to correct a wrong label. */
  labels: { past: string; now: string; future: string };
  points: TimelinePoint[];
  span: TimelineSpan | null;
};

/** A whole material, ready to render. */
export type MaterialDoc = {
  blocks: MaterialBlock[];
};
