import type { MaterialBlock, TimelineBlock, TimelinePoint, TimelineSpan } from "./types";

// The tense-timeline block: its Markdown spelling, its normalization rules, and
// the ONE geometry routine all three renderers draw from.
//
// WHY A FENCED CODE BLOCK IS THE SPELLING. A visual block needs a place in the
// Markdown dialect (docs/architecture/material-visuals.md, "the extension
// pattern"), and unlike `![alt](src)` there is no conventional syntax for
// structured data. A fence with a language tag wins on three counts the
// alternatives lose on:
//
//  - The parser ALREADY tokenises it. `FENCE` in ./parse.ts matches
//    ```` ```timeline ```` today and `isBlockBoundary` already returns true for
//    it, so a timeline can never be swallowed by an adjacent paragraph — the
//    failure mode a brand-new line syntax would have had to defend against.
//  - It degrades to something honest. A renderer that predates this block
//    (an older mobile build on an OTA-lagged device, a third-party Markdown
//    viewer, a teacher's own copy-paste into a note app) shows the payload as a
//    code block. The content is visible and recoverable, not lost.
//  - It stays DATA. The payload below is a fixed set of directives with numeric
//    positions and plain-text labels — never markup a renderer evaluates. That
//    is the "no markup sink" boundary (D-17) the whole visuals design rests on:
//    a model may produce data, only the application produces drawing.
//
// Rejected: a new `:::timeline` container syntax (a second block tokeniser, and
// an unknown-directive body degrades to *nothing* on an older renderer); a JSON
// payload inside the fence (unreadable and un-hand-editable in the "edit as
// text" field, and a stray comma loses the whole block where a stray line here
// loses one directive); an HTML/SVG passthrough (the sink boundary, plus RN and
// the PDF cannot render either).
//
// THE PAYLOAD, one directive per line:
//
//     ```timeline
//     past Past
//     now Now
//     future Future
//     span 20 50 have lived here
//     point 20 I moved to Mérida
//     ```
//
// `past` / `now` / `future` label the axis; `point <at> <label>` is a marker;
// `span <from> <to> <label>` is the one highlighted range. Positions are
// integers 0–100 across the axis, where 50 is the present — NOW is fixed at the
// midpoint on purpose: it is what a teacher draws, it removes a field from the
// wire format and a control from both editors, and every tense a timeline is
// used to teach is expressible by moving the markers instead.
//
// STRICT ON READ. A fence tagged `timeline` whose body has a line this module
// cannot read stays a plain code block — it is never partially drawn, and no
// directive is ever silently dropped from a document a teacher is about to
// save over.

/** The fence language tag that marks a timeline payload. */
export const TIMELINE_LANG = "timeline";

/** The axis runs 0–100. `TIMELINE_NOW` is fixed at the midpoint (see header). */
export const TIMELINE_MIN = 0;
export const TIMELINE_MAX = 100;
export const TIMELINE_NOW = 50;

/** How many markers the EDITORS will add to one timeline. Not a parser rule —
 * a hand- or AI-authored body with more still parses and renders in full; this
 * only stops the add-a-marker button from producing a graphic nobody can read. */
export const TIMELINE_MAX_POINTS = 8;

/** Axis labels a payload that omits them gets. Student-facing product copy, so
 * English on purpose (the students are English learners — see CLAUDE.md), and
 * DATA rather than chrome: it needs no i18n key, the PDF (which has no i18n
 * runtime) draws it with everything else, and a teacher can correct it. */
export const TIMELINE_DEFAULT_LABELS = { past: "Past", now: "Now", future: "Future" } as const;

const PAST_RE = /^past(?:\s+(.*))?$/;
const NOW_RE = /^now(?:\s+(.*))?$/;
const FUTURE_RE = /^future(?:\s+(.*))?$/;
const NUM = "\\d+(?:\\.\\d+)?";
const POINT_RE = new RegExp(`^point\\s+(${NUM})\\s*(.*)$`);
const SPAN_RE = new RegExp(`^span\\s+(${NUM})\\s+(${NUM})\\s*(.*)$`);

/** Flatten a label onto one line and trim it. Every label is serialized as the
 * tail of its own directive line, so a newline would split that line and turn
 * the rest of the payload into an unreadable directive — which, under the
 * strict rule above, would demote the whole block to a code block on the next
 * reparse. Same reasoning as `sanitizeImageAlt`, one level over. */
export function sanitizeTimelineLabel(label: string): string {
  return label.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** Snap a position onto the axis: rounded to an integer (so it serializes and
 * reads back identically) and clamped into 0–100. A non-finite input is not a
 * position at all and falls back to the present. */
export function clampTimelinePosition(at: number): number {
  if (!Number.isFinite(at)) return TIMELINE_NOW;
  return Math.min(TIMELINE_MAX, Math.max(TIMELINE_MIN, Math.round(at)));
}

function normalizePoint(point: TimelinePoint): TimelinePoint {
  return { at: clampTimelinePosition(point.at), label: sanitizeTimelineLabel(point.label) };
}

function normalizeSpan(span: TimelineSpan): TimelineSpan {
  const a = clampTimelinePosition(span.from);
  const b = clampTimelinePosition(span.to);
  return {
    from: Math.min(a, b),
    to: Math.max(a, b),
    label: sanitizeTimelineLabel(span.label),
  };
}

/** Points read left-to-right, always. The legend under the graphic lists them
 * in this order, which is what ties a label to its marker without drawing text
 * into the SVG (see `timelineGeometry`), so the sort is load-bearing rather
 * than cosmetic. `Array.prototype.sort` is stable, so equal positions keep
 * their authored order and the round trip stays a fixed point. */
function sortPoints(points: TimelinePoint[]): TimelinePoint[] {
  return [...points].sort((a, b) => a.at - b.at);
}

/** The minimum viable timeline: at least one marker.
 *
 * An axis with no point and no span is a bare line — nothing is being taught,
 * and (the reason this is a hard rule rather than a style note) `parseTimeline`
 * refuses to read one back, so such a block would silently become a code block
 * the next time the document was serialized and reparsed. Every factory and
 * setter in ./block-editor.ts is guarded by this. */
export function isRepresentableTimeline(block: TimelineBlock): boolean {
  return block.points.length > 0 || block.span !== null;
}

/** Normalize a timeline node into the exact shape the parser produces from its
 * own serialized form — positions snapped, labels flattened, points sorted,
 * span endpoints ordered. Every factory and field setter returns through here,
 * so a hand-built node and a parsed one are indistinguishable. */
export function normalizeTimeline(block: TimelineBlock): TimelineBlock {
  return {
    type: "timeline",
    labels: {
      past: sanitizeTimelineLabel(block.labels.past),
      now: sanitizeTimelineLabel(block.labels.now),
      future: sanitizeTimelineLabel(block.labels.future),
    },
    span: block.span ? normalizeSpan(block.span) : null,
    points: sortPoints(block.points.map(normalizePoint)),
  };
}

/** Read a `timeline`-tagged fence body into a block, or null if it isn't one.
 *
 * Null means "leave it as a code block": an unreadable directive, or a payload
 * with no marker at all. Both are content the parser refuses to guess at rather
 * than half-draw. */
export function parseTimeline(body: string): TimelineBlock | null {
  const labels = { ...TIMELINE_DEFAULT_LABELS } as { past: string; now: string; future: string };
  const points: TimelinePoint[] = [];
  let span: TimelineSpan | null = null;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const past = PAST_RE.exec(line);
    if (past) {
      labels.past = sanitizeTimelineLabel(past[1] ?? "");
      continue;
    }
    const now = NOW_RE.exec(line);
    if (now) {
      labels.now = sanitizeTimelineLabel(now[1] ?? "");
      continue;
    }
    const future = FUTURE_RE.exec(line);
    if (future) {
      labels.future = sanitizeTimelineLabel(future[1] ?? "");
      continue;
    }
    const point = POINT_RE.exec(line);
    if (point) {
      points.push(normalizePoint({ at: Number(point[1]), label: point[2] }));
      continue;
    }
    const range = SPAN_RE.exec(line);
    if (range) {
      // Last one wins — the serializer only ever emits one, so a body with two
      // is hand-authored and the later line is the later intent.
      span = normalizeSpan({ from: Number(range[1]), to: Number(range[2]), label: range[3] });
      continue;
    }
    return null; // an unreadable line: this fence is not a timeline
  }

  const block: TimelineBlock = { type: "timeline", labels, span, points: sortPoints(points) };
  return isRepresentableTimeline(block) ? block : null;
}

/** The fence BODY for a timeline — the inverse of `parseTimeline`. The fence
 * itself is added by `serializeBlock`.
 *
 * All three axis labels are always emitted, so a cleared one reads back as
 * cleared rather than falling to its default on the next parse. No line can
 * ever close the fence early: a label is sanitized onto one line and always
 * follows its directive keyword, so no body line can consist only of fence
 * characters. */
export function serializeTimeline(block: TimelineBlock): string {
  const label = (keyword: string, text: string) => {
    const clean = sanitizeTimelineLabel(text);
    return clean ? `${keyword} ${clean}` : keyword;
  };
  const lines = [
    label("past", block.labels.past),
    label("now", block.labels.now),
    label("future", block.labels.future),
  ];
  if (block.span) {
    const span = normalizeSpan(block.span);
    lines.push(label(`span ${span.from} ${span.to}`, span.label));
  }
  for (const point of sortPoints(block.points.map(normalizePoint))) {
    lines.push(label(`point ${point.at}`, point.label));
  }
  return lines.join("\n");
}

/** Narrow a block to a timeline. */
export function isTimelineBlock(block: MaterialBlock): block is TimelineBlock {
  return block.type === "timeline";
}

// --- geometry ----------------------------------------------------------------
//
// ONE layout, three drawing routines. Web draws it as inline SVG, mobile with
// the PDF with @react-pdf/renderer's Svg primitives — but
// none of them decides where anything goes, or the same document would look
// like three different diagrams.
//
// NO TEXT INSIDE THE GRAPHIC. Marker labels are real platform text below it,
// not `<text>` in the SVG, for the reason TrendLineChart.tsx already documents
// on mobile: none of the three surfaces can measure a string, so on-axis labels
// either collide with their neighbours or overflow the viewBox, and there is no
// safe way to find out which. Below the graphic they wrap, translate, get
// selected and get read aloud. The legend lists markers left-to-right in axis
// order (see `sortPoints`), which is what ties each label to its marker.
//
// The viewBox is fixed and the height is BOUNDED (the PDF is fixed-layout — a
// graphic that grew with its content would push the rest of a handout onto the
// next page, exactly what the image block's `maxHeight` exists to prevent).

export const TIMELINE_VIEW_WIDTH = 320;
export const TIMELINE_VIEW_HEIGHT = 56;

// The axis line, with room at each end for the arrow head.
const AXIS_X1 = 10;
const AXIS_X2 = 310;
const AXIS_Y = 38;
// The marker track, inset from the line ends and centred on the viewBox so
// position 50 lands exactly under the middle of the label row below.
const TRACK_X1 = 24;
const TRACK_X2 = 296;
const SPAN_Y = 14;
const SPAN_HEIGHT = 10;
const POINT_RADIUS = 4.5;
const NOW_Y1 = 27;
const NOW_Y2 = 49;

export type TimelineGeometry = {
  width: number;
  height: number;
  /** The horizontal axis, past → future. */
  axis: { x1: number; y1: number; x2: number; y2: number };
  /** Arrow head at the future end, as SVG polygon `points`. */
  arrow: string;
  /** The present divider. */
  now: { x: number; y1: number; y2: number };
  /** The highlighted range, above the axis. */
  span: { x: number; y: number; width: number; height: number; radius: number } | null;
  /** Event markers, on the axis, in axis order. */
  points: { cx: number; cy: number; r: number }[];
};

/** Where a 0–100 axis position sits in viewBox units. */
export function timelineX(at: number): number {
  const clamped = Math.min(TIMELINE_MAX, Math.max(TIMELINE_MIN, at));
  return TRACK_X1 + (clamped / TIMELINE_MAX) * (TRACK_X2 - TRACK_X1);
}

export function timelineGeometry(block: TimelineBlock): TimelineGeometry {
  const span = block.span ? normalizeSpan(block.span) : null;
  const spanX = span ? timelineX(span.from) : 0;
  // A zero-width span (from === to) is a real thing to draw — "at this exact
  // moment" — so it keeps a minimum width rather than disappearing.
  const spanWidth = span ? Math.max(SPAN_HEIGHT, timelineX(span.to) - spanX) : 0;

  return {
    width: TIMELINE_VIEW_WIDTH,
    height: TIMELINE_VIEW_HEIGHT,
    axis: { x1: AXIS_X1, y1: AXIS_Y, x2: AXIS_X2, y2: AXIS_Y },
    arrow: `${AXIS_X2 + 6},${AXIS_Y} ${AXIS_X2 - 3},${AXIS_Y - 5} ${AXIS_X2 - 3},${AXIS_Y + 5}`,
    now: { x: timelineX(TIMELINE_NOW), y1: NOW_Y1, y2: NOW_Y2 },
    span: span
      ? { x: spanX, y: SPAN_Y, width: spanWidth, height: SPAN_HEIGHT, radius: SPAN_HEIGHT / 2 }
      : null,
    points: block.points.map((point) => ({
      cx: timelineX(point.at),
      cy: AXIS_Y,
      r: POINT_RADIUS,
    })),
  };
}

/** The plain-text lines a text-only consumer sees — the homework-review excerpt
 * (see `extractHomeworkExcerptText`) and nothing else. A timeline inside an
 * exercise callout IS part of the question ("when did this happen?"), so its
 * labels have to survive the flattening; the numeric positions do not, because
 * a coordinate is noise to a model reading prose. */
export function timelineTextLines(block: TimelineBlock): string[] {
  const lines: string[] = [];
  const axis = [block.labels.past, block.labels.now, block.labels.future].filter(Boolean);
  if (axis.length) lines.push(axis.join(" · "));
  if (block.span?.label) lines.push(block.span.label);
  for (const point of block.points) if (point.label) lines.push(point.label);
  return lines;
}
