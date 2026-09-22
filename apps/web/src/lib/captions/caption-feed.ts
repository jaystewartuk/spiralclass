// The caption FEED: every subtitle line this viewer has been sent this call,
// in order, plus the derived window of what is currently on screen.
//
// Replaces use-caption-ticker.ts, which kept a rolling three of the single
// "current line" value and dropped everything else on the floor. That was
// enough for a band and nothing else, and it cost the two things a lesson
// actually needs:
//
//   * SCROLLBACK. A learner who looks down at her notes loses the sentence.
//     Live captions are the one part of a lesson that scrolls past at the
//     speed of speech and cannot be replayed, so "what did she just say?"
//     had no answer.
//   * PER-LINE LIFETIME. The old ticker cleared ALL lines at once, six
//     seconds after the LAST one arrived — so a line that had been up for
//     five seconds and one that landed a moment ago vanished together,
//     mid-read. Each line now ages on its own clock.
//
// Pure state transitions here, React wiring in use-caption-feed.ts, so the
// branching is unit-testable without a render harness — the same split
// use-caption-ticker.ts had.

import type { CaptionLine } from "@spiralclass/shared";

// One caption as the UI consumes it: the wire line plus when THIS client
// received it. The receipt time (not any timestamp from the sender) drives
// both the on-screen lifetime and the transcript's clock, because it is the
// only one measured in the reader's own frame of reference.
export type CaptionEntry = {
  id: string;
  // The translated text — what this viewer can read.
  text: string;
  // What the speaker actually said, when the sender knew it (CaptionLine.src).
  src?: string;
  // Speaker's participant identity; the view resolves it to a display name.
  from?: string;
  lang?: string;
  srcLang?: string;
  // Client receipt time (epoch ms).
  at: number;
};

export type CaptionFeedState = {
  // Every line this call, oldest first, capped at TRANSCRIPT_MAX.
  entries: CaptionEntry[];
  // Whether the room is currently captioning (the teacher's switch, relayed
  // as a "state" message). false → the band hides; the transcript persists,
  // because turning captions off should not erase what was already said.
  active: boolean;
};

export const INITIAL_FEED_STATE: CaptionFeedState = { entries: [], active: false };

// How long a line stays on screen after it arrives. Longer than the 6s the
// old ticker used, because that 6s was the lifetime of the WHOLE band
// measured from the LAST line — an early line in a fast exchange really got
// two or three. Measured per line, 9s is a comfortable read of a
// subtitle-length sentence plus a beat.
export const LINE_TTL_MS = 9_000;

// The most lines the band shows at once. Three is the ceiling at which the
// stack still reads as "recent speech" rather than a wall of text over
// someone's face, and it is what the previous ticker settled on.
export const BAND_MAX_LINES = 3;

// Transcript cap. A 60-minute lesson at a brisk conversational pace lands
// well under this; the cap exists so an all-day room can never grow the
// array without bound, not to trim a real lesson.
export const TRANSCRIPT_MAX = 500;

export type CaptionFeedEvent =
  { kind: "line"; line: CaptionLine; at: number } | { kind: "active"; on: boolean };

export function reduceCaptionFeed(
  state: CaptionFeedState,
  event: CaptionFeedEvent,
): CaptionFeedState {
  if (event.kind === "active") {
    if (state.active === event.on) return state;
    // Deliberately keeps `entries`. Captions going off clears the BAND (the
    // view derives that from `active`), but erasing the transcript would
    // throw away the lesson so far because the teacher reached for a switch.
    return { ...state, active: event.on };
  }

  const { line, at } = event;
  const entry: CaptionEntry = {
    id: line.id,
    text: line.text,
    src: line.src,
    from: line.from,
    lang: line.lang,
    srcLang: line.srcLang,
    at,
  };
  // A redelivery of a line we already hold must replace, never stack —
  // LiveKit's reliable channel can deliver twice, and the id exists for
  // exactly this.
  const existing = state.entries.findIndex((e) => e.id === line.id);
  if (existing !== -1) {
    const entries = state.entries.slice();
    // Keep the ORIGINAL receipt time: a redelivery is not a new utterance,
    // and re-arming the lifetime would strand a stale line on screen.
    entries[existing] = { ...entry, at: state.entries[existing].at };
    return { ...state, entries, active: true };
  }
  const entries = [...state.entries, entry];
  return {
    entries: entries.length > TRANSCRIPT_MAX ? entries.slice(-TRANSCRIPT_MAX) : entries,
    active: true,
  };
}

// The lines the band should be showing at `now`: the most recent
// BAND_MAX_LINES still inside their own TTL, oldest first. Pure and
// time-parameterised so the caller (a ticking hook) decides when to
// re-evaluate and a test can step the clock by hand.
export function visibleCaptions(
  state: CaptionFeedState,
  now: number,
  opts: { ttlMs?: number; max?: number } = {},
): CaptionEntry[] {
  if (!state.active) return [];
  const ttl = opts.ttlMs ?? LINE_TTL_MS;
  const max = opts.max ?? BAND_MAX_LINES;
  const live = state.entries.filter((e) => now - e.at < ttl);
  return live.slice(-max);
}

// When the band next needs re-rendering because a line will have expired, or
// null if nothing is on screen. Lets the hook arm ONE timer for the next
// actual expiry instead of polling: a call runs for an hour, and a 250ms tick
// would re-render the stage 14,400 times to change nothing.
export function nextExpiryAt(
  state: CaptionFeedState,
  now: number,
  ttlMs = LINE_TTL_MS,
): number | null {
  const live = state.entries.filter((e) => now - e.at < ttlMs);
  if (live.length === 0) return null;
  return Math.min(...live.map((e) => e.at + ttlMs));
}
