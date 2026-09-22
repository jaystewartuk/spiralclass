import { sanitizeImageAlt, sanitizeImageSrc } from "./images";
import { parseBlockText, parseInline } from "./parse";
import {
  clampTimelinePosition,
  isRepresentableTimeline,
  normalizeTimeline,
  sanitizeTimelineLabel,
  TIMELINE_DEFAULT_LABELS,
  TIMELINE_MAX,
  TIMELINE_MAX_POINTS,
  TIMELINE_NOW,
} from "./timeline";
import type {
  CalloutVariant,
  InlineNode,
  ListItem,
  MaterialBlock,
  TimelineBlock,
  TimelinePoint,
} from "./types";

// Block-level structural ops over a flat MaterialBlock[] array — the pure core
// the per-block editor (Phase 4 of the material-editing design)
// drives inside a section card. Every block edits inline, in place — no
// expand step. Sibling to sections.ts, which operates one level up (a
// document's sections); this operates one level down (a section's own body
// blocks).
//
// Every function here is FLAT — it takes and returns one `MaterialBlock[]`
// array and never reaches into a callout's or quote's own nested `blocks`.
// Recursive editing (a callout's body, itself editable the same way) is a
// property of how the UI *composes* this module, not of the module itself:
// the component editing a callout's nested blocks is just another instance of
// the same block-list editor, called with `callout.blocks` and an `onChange`
// that writes the result back via `updateBlockAt` at the callout's own index.
// No path/address scheme is needed here because of that composition — see
// the component tree in material-editor.tsx / MaterialSectionEditor.tsx.
//
// Every function is pure and returns a NEW array/block; nothing here mutates
// its input, matching sections.ts's discipline (so a caller can keep the
// previous tree for undo — though in practice the whole-body undo stack in
// editor.ts is the one that matters; see SectionAction["editBlocks"]).

export type ListBlock = Extract<MaterialBlock, { type: "list" }>;
export type TableBlock = Extract<MaterialBlock, { type: "table" }>;
export type CalloutBlock = Extract<MaterialBlock, { type: "callout" }>;
export type ImageBlock = Extract<MaterialBlock, { type: "image" }>;
export type { TimelineBlock } from "./types";

/** What the parser itself produces for zero-length inline content
 * (`parseInline("")`) — a single empty text node, never a bare `[]`. Every
 * "blank" cell/item a factory below builds goes through this (or through
 * `parseInline` directly) rather than a literal `[]`, so it matches every
 * OTHER inline run in the tree, which is always parser-derived. This isn't
 * cosmetic: `serializeInline([])` and `serializeInline([{type:"text",
 * value:""}])` both render to `""`, but a lone empty PARAGRAPH block
 * serializes to `""` too — and reparsing `""` yields zero blocks, not one
 * empty paragraph back. A brand-new block must therefore never be truly
 * blank, or it silently disappears the instant the section is next
 * serialized and reparsed. */
function emptyInline(): InlineNode[] {
  return parseInline("");
}

/** Collapse newlines out of text destined for a single-line position (an item
 * head, a callout title, a table cell). All three serialize onto one source
 * line; a raw newline — reachable through paste on Android's TextInput even
 * when the field itself is single-line — would otherwise split the line and
 * corrupt the surrounding structure on the next reparse. */
function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

// --- generic block-list ops --------------------------------------------------

/** Replace the block at `index` with `replacement` (0 or more blocks — 0
 * deletes it, 2+ splits it in place). An out-of-range index returns `blocks`
 * unchanged. */
export function replaceBlockAt(
  blocks: MaterialBlock[],
  index: number,
  replacement: MaterialBlock[],
): MaterialBlock[] {
  if (index < 0 || index >= blocks.length) return blocks;
  return [...blocks.slice(0, index), ...replacement, ...blocks.slice(index + 1)];
}

/** Replace the block at `index` with exactly one new block — the common case
 * (a field-level edit: a callout's variant/title, a table cell) that can
 * never split or disappear. */
export function updateBlockAt(
  blocks: MaterialBlock[],
  index: number,
  next: MaterialBlock,
): MaterialBlock[] {
  return replaceBlockAt(blocks, index, [next]);
}

/** Delete the block at `index`. */
export function removeBlockAt(blocks: MaterialBlock[], index: number): MaterialBlock[] {
  return replaceBlockAt(blocks, index, []);
}

/** Insert `block` at position `index` (clamped to the ends, so
 * `blocks.length` appends). */
export function insertBlockAt(
  blocks: MaterialBlock[],
  index: number,
  block: MaterialBlock,
): MaterialBlock[] {
  const at = Math.min(Math.max(index, 0), blocks.length);
  return [...blocks.slice(0, at), block, ...blocks.slice(at)];
}

/** Re-parse a block's edited Markdown source (from `serializeBlock`) and
 * splice the result back in — the shared primitive behind every "edit as
 * text" field (paragraph, quote, code). See `parseBlockText` for why 0, 1, or
 * several resulting blocks are all valid outcomes. */
export function editBlockText(
  blocks: MaterialBlock[],
  index: number,
  text: string,
): MaterialBlock[] {
  return replaceBlockAt(blocks, index, parseBlockText(text));
}

// --- callout field edits -----------------------------------------------------

export function updateCalloutVariant(callout: CalloutBlock, variant: CalloutVariant): CalloutBlock {
  return { ...callout, variant };
}

/** Empty text clears the title (the renderer then shows the variant's
 * localized default label, same as an author-omitted `> [!tip]` with no
 * title text). */
export function updateCalloutTitle(callout: CalloutBlock, text: string): CalloutBlock {
  const clean = singleLine(text);
  return { ...callout, title: clean.trim() ? parseInline(clean) : null };
}

// --- list-item ops ------------------------------------------------------------

/** A new item matches the list's own flavor: unchecked if any sibling is a
 * task item, a plain bullet/number otherwise — so adding a row to a checklist
 * doesn't silently drop the checkbox, and adding one to a plain list doesn't
 * invent one. */
function defaultChecked(list: ListBlock): boolean | null {
  return list.items.some((item) => item.checked !== null) ? false : null;
}

export function updateListItemText(list: ListBlock, index: number, text: string): ListBlock {
  if (index < 0 || index >= list.items.length) return list;
  const items = list.items.map((item, i) =>
    i === index ? { ...item, inlines: parseInline(singleLine(text)) } : item,
  );
  return { ...list, items };
}

export function toggleListItemChecked(list: ListBlock, index: number): ListBlock {
  const item = list.items[index];
  if (!item || item.checked === null) return list;
  const items = list.items.map((it, i) => (i === index ? { ...it, checked: !it.checked } : it));
  return { ...list, items };
}

export function insertListItem(list: ListBlock, index: number, text = ""): ListBlock {
  const item: ListItem = {
    inlines: parseInline(singleLine(text)),
    checked: defaultChecked(list),
    children: [],
  };
  const at = Math.min(Math.max(index, 0), list.items.length);
  return { ...list, items: [...list.items.slice(0, at), item, ...list.items.slice(at)] };
}

/** A list always keeps at least one item — same rule (and reason) as
 * `removeTableColumn`: an empty `items` array serializes to `""` and the whole
 * block silently evaporates on the next reparse. Deleting the last item is
 * expressed as deleting the block, which the UI offers explicitly. */
export function removeListItem(list: ListBlock, index: number): ListBlock {
  if (index < 0 || index >= list.items.length || list.items.length <= 1) return list;
  return { ...list, items: list.items.filter((_, i) => i !== index) };
}

/** Splice semantics, same as `moveSection`: remove `from`, insert at `to` in
 * the shortened array. `to` is clamped into range; an out-of-range `from`, or
 * a no-op move, returns the input list unchanged (same reference). */
export function moveListItem(list: ListBlock, from: number, to: number): ListBlock {
  if (from < 0 || from >= list.items.length) return list;
  const target = Math.min(Math.max(to, 0), list.items.length - 1);
  if (target === from) return list;
  const items = [...list.items];
  const [moved] = items.splice(from, 1);
  items.splice(target, 0, moved);
  return { ...list, items };
}

// --- table ops ----------------------------------------------------------------

/** `row: -1` addresses the header row; `0..rows.length-1` addresses a data
 * row. Keeping one function for both (rather than a separate header setter)
 * means the UI's cell grid doesn't need to special-case row 0. */
export function updateTableCell(
  table: TableBlock,
  row: number,
  col: number,
  text: string,
): TableBlock {
  const cell = parseInline(singleLine(text));
  if (row === -1) {
    if (col < 0 || col >= table.header.length) return table;
    return { ...table, header: table.header.map((c, i) => (i === col ? cell : c)) };
  }
  if (row < 0 || row >= table.rows.length || col < 0 || col >= table.header.length) return table;
  return {
    ...table,
    rows: table.rows.map((r, ri) => (ri === row ? r.map((c, ci) => (ci === col ? cell : c)) : r)),
  };
}

export function insertTableRow(table: TableBlock, index: number): TableBlock {
  const row: InlineNode[][] = table.header.map(() => emptyInline());
  const at = Math.min(Math.max(index, 0), table.rows.length);
  return { ...table, rows: [...table.rows.slice(0, at), row, ...table.rows.slice(at)] };
}

export function removeTableRow(table: TableBlock, index: number): TableBlock {
  if (index < 0 || index >= table.rows.length) return table;
  return { ...table, rows: table.rows.filter((_, i) => i !== index) };
}

/** A table always keeps at least one column — dropping the last one would
 * leave a table block with no cells at all, which nothing downstream (the
 * renderers, the parser) expects. */
export function insertTableColumn(table: TableBlock, index: number): TableBlock {
  const at = Math.min(Math.max(index, 0), table.header.length);
  const insert = (cells: InlineNode[][]): InlineNode[][] => [
    ...cells.slice(0, at),
    emptyInline(),
    ...cells.slice(at),
  ];
  return {
    ...table,
    header: insert(table.header),
    rows: table.rows.map(insert),
    align: [...table.align.slice(0, at), null, ...table.align.slice(at)],
  };
}

export function removeTableColumn(table: TableBlock, index: number): TableBlock {
  if (index < 0 || index >= table.header.length || table.header.length <= 1) return table;
  const drop = (cells: InlineNode[][]): InlineNode[][] => cells.filter((_, i) => i !== index);
  return {
    ...table,
    header: drop(table.header),
    rows: table.rows.map(drop),
    align: table.align.filter((_, i) => i !== index),
  };
}

// --- new-block factories (the "add block" menu) -------------------------------
//
// Only the types a teacher can freely add are here — code and quote blocks
// are edit-as-text on whatever the AI already produced, not menu-insertable
// (per the plan: the add-block menu is "paragraph, list, each callout
// variant, table, divider").

/** `text` is required (no empty default) — see `emptyInline`'s comment: an
 * inserted paragraph with no content at all would vanish the instant the
 * section is next serialized. Callers pass a localized placeholder (the same
 * pattern `insertSection`'s `title` already uses in editor.ts). */
export function newParagraphBlock(text: string): MaterialBlock {
  return { type: "paragraph", inlines: parseInline(text) };
}

export function newListBlock(text: string): MaterialBlock {
  return {
    type: "list",
    ordered: false,
    items: [{ inlines: parseInline(text), checked: null, children: [] }],
  };
}

export function newCalloutBlock(variant: CalloutVariant): MaterialBlock {
  // Unlike a paragraph/list item, an empty callout body is fine: with no body
  // line at all, `serializeBlock` emits just the `> [!variant]` marker, and
  // reparsing that alone reads back the same empty `blocks: []` — so it
  // doesn't need placeholder content to survive a round trip.
  return { type: "callout", variant, title: null, blocks: [] };
}

/** A 2x2 starter grid — the smallest table shape that still shows the
 * add/remove row and column affordances doing something. */
export function newTableBlock(): MaterialBlock {
  return {
    type: "table",
    header: [emptyInline(), emptyInline()],
    rows: [[emptyInline(), emptyInline()]],
    align: [null, null],
  };
}

export function newDividerBlock(): MaterialBlock {
  return { type: "divider" };
}

/** An image block for an already-uploaded image.
 *
 * `src` is required and must be non-empty AFTER sanitizing, because an image
 * with no src has no representable Markdown form (`![alt]()` does not reparse
 * as an image) and would evaporate on the next round trip — the same failure
 * `emptyInline` exists to prevent one level down. That is why the add-block
 * menus insert an image only once its upload has SUCCEEDED, rather than
 * inserting an empty placeholder and filling it in afterwards. Returns null
 * for an unusable src so a caller can surface the failure instead of writing
 * a block that will silently disappear. */
export function newImageBlock(src: string, alt: string): MaterialBlock | null {
  const cleanSrc = sanitizeImageSrc(src);
  if (!cleanSrc) return null;
  return { type: "image", src: cleanSrc, alt: sanitizeImageAlt(alt).trim() };
}

/** Retitle an image. The alt doubles as the caption every renderer prints, so
 * an empty string is legitimate (a purely decorative picture) — unlike a
 * paragraph's text, it can't make the block vanish. */
export function updateImageAlt(image: ImageBlock, alt: string): ImageBlock {
  return { ...image, alt: sanitizeImageAlt(alt).trim() };
}

/** Point an image at a different source (a re-upload replacing the picture).
 * An unusable src leaves the block untouched — same guard, same reason, as
 * `newImageBlock`. */
export function updateImageSrc(image: ImageBlock, src: string): ImageBlock {
  const cleanSrc = sanitizeImageSrc(src);
  return cleanSrc ? { ...image, src: cleanSrc } : image;
}

// --- timeline ops -------------------------------------------------------------
//
// Every one of these returns through `normalizeTimeline`, so an edited node is
// byte-for-byte what the parser would produce from the same body: positions
// snapped to integers in range, labels flattened onto one line, points sorted
// left-to-right. Without that the editor could hold a node that its own
// serialize→reparse cycle would change under it on the next save.
//
// The representability guard here is `isRepresentableTimeline`: a timeline with
// no point AND no span serializes to a fence that reads back as a CODE block,
// not a timeline (see ./timeline.ts) — the exact silent-evaporation failure
// `newImageBlock`'s empty-src refusal exists to prevent, one block type over.
// So the factory refuses to build one, and the two removal ops refuse to leave
// one behind.

/** A starter timeline: a highlighted span running from the past up to the
 * present, one marker at its start, and the default axis labels — the shape of
 * the "I have lived here since…" diagram a teacher draws most.
 *
 * `spanLabel`/`pointLabel` are caller-supplied (a localized placeholder, the
 * same pattern `newParagraphBlock` uses); both may be empty, because a marker
 * with no caption is still a marker and still draws. Returns null only for the
 * shape the parser would not read back — kept as an explicit null, rather than
 * being unreachable, so a future caller cannot quietly build an empty axis. */
export function newTimelineBlock(spanLabel: string, pointLabel: string): MaterialBlock | null {
  const block = normalizeTimeline({
    type: "timeline",
    labels: { ...TIMELINE_DEFAULT_LABELS },
    span: { from: 20, to: TIMELINE_NOW, label: spanLabel },
    points: [{ at: 20, label: pointLabel }],
  });
  return isRepresentableTimeline(block) ? block : null;
}

/** Retitle one of the three axis labels. Clearing one is legitimate — a
 * timeline with a bare axis still draws, and an empty label reads back as
 * empty rather than falling to its default (see `serializeTimeline`). */
export function updateTimelineLabel(
  timeline: TimelineBlock,
  which: "past" | "now" | "future",
  text: string,
): TimelineBlock {
  return normalizeTimeline({
    ...timeline,
    labels: { ...timeline.labels, [which]: sanitizeTimelineLabel(text) },
  });
}

/** Add a marker. Capped at `TIMELINE_MAX_POINTS`: past that the circles overlap
 * into an unreadable smear and the legend stops fitting on a phone, so the
 * button goes inert rather than producing a graphic nobody can use. A hand- or
 * AI-authored body with more still parses and renders in full — this is an
 * editor guard, not a document rule. */
export function insertTimelinePoint(
  timeline: TimelineBlock,
  at: number,
  label: string,
): TimelineBlock {
  if (timeline.points.length >= TIMELINE_MAX_POINTS) return timeline;
  const point: TimelinePoint = { at: clampTimelinePosition(at), label };
  return normalizeTimeline({ ...timeline, points: [...timeline.points, point] });
}

export function updateTimelinePointLabel(
  timeline: TimelineBlock,
  index: number,
  label: string,
): TimelineBlock {
  if (index < 0 || index >= timeline.points.length) return timeline;
  return normalizeTimeline({
    ...timeline,
    points: timeline.points.map((point, i) => (i === index ? { ...point, label } : point)),
  });
}

/** Move a marker along the axis. The result is re-sorted, so a marker dragged
 * past its neighbour changes index — callers address markers by index within a
 * single render, never across one. */
export function updateTimelinePointAt(
  timeline: TimelineBlock,
  index: number,
  at: number,
): TimelineBlock {
  if (index < 0 || index >= timeline.points.length) return timeline;
  return normalizeTimeline({
    ...timeline,
    points: timeline.points.map((point, i) =>
      i === index ? { ...point, at: clampTimelinePosition(at) } : point,
    ),
  });
}

/** Remove a marker, unless it is the last thing on the timeline — see the
 * representability note above. Deleting the last marker is expressed as
 * deleting the block, which both editors offer explicitly. */
export function removeTimelinePoint(timeline: TimelineBlock, index: number): TimelineBlock {
  if (index < 0 || index >= timeline.points.length) return timeline;
  const points = timeline.points.filter((_, i) => i !== index);
  const next = normalizeTimeline({ ...timeline, points });
  return isRepresentableTimeline(next) ? next : timeline;
}

/** Set (or replace) the highlighted span. Endpoints are ordered by
 * `normalizeTimeline`, so a caller may pass them either way round. */
export function setTimelineSpan(
  timeline: TimelineBlock,
  from: number,
  to: number,
  label: string,
): TimelineBlock {
  return normalizeTimeline({ ...timeline, span: { from, to, label } });
}

export function updateTimelineSpanLabel(timeline: TimelineBlock, label: string): TimelineBlock {
  if (!timeline.span) return timeline;
  return normalizeTimeline({ ...timeline, span: { ...timeline.span, label } });
}

/** Drop the highlighted span, unless it is the only thing on the timeline. */
export function clearTimelineSpan(timeline: TimelineBlock): TimelineBlock {
  const next = normalizeTimeline({ ...timeline, span: null });
  return isRepresentableTimeline(next) ? next : timeline;
}

/** The span a teacher gets when adding one to a timeline that has none: from
 * the first marker to the present, which is the tense being taught in the
 * overwhelming majority of cases (`have lived`, `has been`, `since 2020`). */
export function defaultTimelineSpan(timeline: TimelineBlock): { from: number; to: number } {
  const first = timeline.points[0]?.at ?? 0;
  return first < TIMELINE_NOW
    ? { from: first, to: TIMELINE_NOW }
    : { from: TIMELINE_NOW, to: Math.max(first, Math.min(TIMELINE_MAX, TIMELINE_NOW + 30)) };
}
