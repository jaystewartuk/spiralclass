// How a teacher wants the live subtitles cut into lines (D-185, D-198).
//
// The browser's recogniser decides on its own when an utterance is finished,
// by waiting for a gap in the speech. A student who talks fast without
// pausing therefore gets nothing translated until they stop, and then all of
// it at once. These two dials let a teacher cut earlier than the browser
// would, without any new recogniser:
//
//   pauseMs  — translate what has been heard so far once nothing new has been
//              heard for this long. 0 = leave it to the browser (today's
//              behaviour).
//   maxChars — never let more than about this many characters wait for a
//              translation; cut at the last finished word. 0 = no limit
//              (today's behaviour).
//
// Both default to 0, so a teacher who never opens the page gets exactly what
// shipped before. The values are the teacher's, per account, and reach both
// browsers of a class through the caption session — the recognising browser
// is the one that applies them, and it is not always the teacher's.
//
// Bounded so a typo cannot make subtitles unusable: a pause under
// CAPTION_PAUSE_MIN_MS cuts mid-breath and reads word by word, which is what
// Ana asked us not to do; a length under CAPTION_MAX_CHARS_MIN cuts mid-clause.

export type CaptionTiming = {
  pauseMs: number;
  maxChars: number;
};

export const CAPTION_TIMING_DEFAULTS: CaptionTiming = { pauseMs: 0, maxChars: 0 };

export const CAPTION_PAUSE_MIN_MS = 400;
export const CAPTION_PAUSE_MAX_MS = 3000;
export const CAPTION_PAUSE_STEP_MS = 100;
export const CAPTION_MAX_CHARS_MIN = 40;
export const CAPTION_MAX_CHARS_MAX = 300;
export const CAPTION_MAX_CHARS_STEP = 10;

function clampDial(raw: unknown, min: number, max: number, step: number): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  const snapped = Math.round(n / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

// Whatever is stored or posted, as a valid setting, field by field. A value
// that is missing, malformed or out of range degrades to that field's own
// nearest bound (or off), never throws, and never takes the other field with it.
export function parseCaptionTiming(raw: unknown): CaptionTiming {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    pauseMs: clampDial(
      obj.pauseMs,
      CAPTION_PAUSE_MIN_MS,
      CAPTION_PAUSE_MAX_MS,
      CAPTION_PAUSE_STEP_MS,
    ),
    maxChars: clampDial(
      obj.maxChars,
      CAPTION_MAX_CHARS_MIN,
      CAPTION_MAX_CHARS_MAX,
      CAPTION_MAX_CHARS_STEP,
    ),
  };
}

export function isDefaultCaptionTiming(timing: CaptionTiming): boolean {
  return timing.pauseMs === 0 && timing.maxChars === 0;
}

// The part of `heard` not yet delivered, given the text this utterance has
// already had cut from it. Recognisers revise the tail of what they have
// heard but not the start, so an exact prefix is the normal case; when the
// start was revised too, fall back to counting what was cut — by words where
// the text has spaces, by characters where it does not (Chinese, Japanese).
export function captionRemainder(cut: string, heard: string): string {
  if (!cut) return heard;
  if (heard.toLowerCase().startsWith(cut.toLowerCase())) return heard.slice(cut.length).trim();
  if (!/\s/.test(cut) && !/\s/.test(heard)) return heard.slice(cut.length).trim();
  const cutWords = cut.split(/\s+/).length;
  return heard.split(/\s+/).slice(cutWords).join(" ").trim();
}

// Where to cut `text` so that no more than `maxChars` is left waiting: after
// the last finished word, keeping the word still being heard out of the cut.
// Returns the length of the part to deliver, or 0 to wait.
export function captionCutPoint(text: string, maxChars: number): number {
  if (maxChars <= 0 || text.length < maxChars) return 0;
  const lastSpace = text.lastIndexOf(" ");
  if (lastSpace > 0) return lastSpace;
  // No spaces to cut at (unspaced scripts): cut at the limit itself.
  return /\s/.test(text) ? 0 : maxChars;
}

// What a teacher's timing would do to a sentence, for the settings page's
// preview. `sample` is a spoken run of words where "|" marks a breath, a gap of
// PREVIEW_BREATH_MS in an otherwise steady PREVIEW_WORD_MS per word. Models the
// two cuts the live chunker makes — a gap of at least pauseMs, and more than
// maxChars waiting — and, with both off, the browser's own behaviour here: one
// line when the speaker finally stops.
export const PREVIEW_WORD_MS = 250;
export const PREVIEW_BREATH_MS = 900;

export function previewCaptionCuts(sample: string, timing: CaptionTiming): string[] {
  const lines: string[] = [];
  let waiting: string[] = [];
  const flush = () => {
    if (waiting.length) lines.push(waiting.join(" "));
    waiting = [];
  };
  let gap = 0;
  for (const token of sample.split(/\s+/)) {
    if (token === "|") {
      gap = PREVIEW_BREATH_MS;
      continue;
    }
    if (timing.pauseMs > 0 && gap >= timing.pauseMs) flush();
    gap = PREVIEW_WORD_MS;
    waiting.push(token);
    const joined = waiting.join(" ");
    const at = captionCutPoint(joined, timing.maxChars);
    if (at > 0) {
      lines.push(joined.slice(0, at).trim());
      waiting = joined.slice(at).trim().split(" ").filter(Boolean);
    }
  }
  flush();
  return lines;
}
