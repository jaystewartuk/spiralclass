import { describe, expect, it } from "vitest";
import type { CaptionLine } from "@spiralclass/shared";
import {
  BAND_MAX_LINES,
  INITIAL_FEED_STATE,
  LINE_TTL_MS,
  TRANSCRIPT_MAX,
  nextExpiryAt,
  reduceCaptionFeed,
  visibleCaptions,
  type CaptionFeedState,
} from "@/lib/captions/caption-feed";

// The caption feed's whole job is the two properties the old three-line
// ticker could not hold: every line is KEPT (so a transcript exists), and
// each line ages on ITS OWN clock (so a fast exchange doesn't clear
// mid-read). Both are asserted here against a hand-stepped clock.

const line = (id: string, over: Partial<CaptionLine> = {}): CaptionLine => ({
  t: "line",
  for: "student-1",
  id,
  text: `translated ${id}`,
  ...over,
});

const feed = (lines: [string, number][], over: Partial<CaptionFeedState> = {}): CaptionFeedState =>
  lines.reduce<CaptionFeedState>(
    (state, [id, at]) => reduceCaptionFeed(state, { kind: "line", line: line(id), at }),
    { ...INITIAL_FEED_STATE, ...over },
  );

describe("reduceCaptionFeed", () => {
  it("appends lines in arrival order and marks the feed active", () => {
    const state = feed([
      ["a", 1_000],
      ["b", 2_000],
    ]);
    expect(state.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(state.active).toBe(true);
  });

  it("carries the source text, speaker and both language codes through", () => {
    const state = reduceCaptionFeed(INITIAL_FEED_STATE, {
      kind: "line",
      at: 1_000,
      line: line("a", {
        text: "How are you?",
        src: "¿Cómo estás?",
        from: "teacher-1",
        lang: "en",
        srcLang: "es",
      }),
    });
    expect(state.entries[0]).toEqual({
      id: "a",
      text: "How are you?",
      src: "¿Cómo estás?",
      from: "teacher-1",
      lang: "en",
      srcLang: "es",
      at: 1_000,
    });
  });

  it("replaces rather than stacks a redelivered line, keeping the ORIGINAL arrival time", () => {
    // LiveKit's reliable channel can deliver twice. Re-arming the lifetime on
    // a redelivery would strand a line that should already have aged out.
    const first = feed([["a", 1_000]]);
    const again = reduceCaptionFeed(first, {
      kind: "line",
      at: 8_000,
      line: line("a", { text: "corrected" }),
    });
    expect(again.entries).toHaveLength(1);
    expect(again.entries[0].text).toBe("corrected");
    expect(again.entries[0].at).toBe(1_000);
  });

  it("keeps the transcript when captions are switched off", () => {
    // Turning the room's switch off hides the band. It must not erase what
    // was already said — that would throw away the lesson so far.
    const state = reduceCaptionFeed(feed([["a", 1_000]]), { kind: "active", on: false });
    expect(state.active).toBe(false);
    expect(state.entries).toHaveLength(1);
  });

  it("returns the same object when a state message changes nothing", () => {
    const state = feed([["a", 1_000]]);
    expect(reduceCaptionFeed(state, { kind: "active", on: true })).toBe(state);
  });

  it("caps the transcript so a long-lived room cannot grow without bound", () => {
    let state = INITIAL_FEED_STATE;
    for (let i = 0; i < TRANSCRIPT_MAX + 25; i++) {
      state = reduceCaptionFeed(state, { kind: "line", line: line(`l${i}`), at: i });
    }
    expect(state.entries).toHaveLength(TRANSCRIPT_MAX);
    // The cap drops the OLDEST, never the newest.
    expect(state.entries[state.entries.length - 1].id).toBe(`l${TRANSCRIPT_MAX + 24}`);
  });
});

describe("visibleCaptions", () => {
  it("shows nothing while the feed is inactive, even holding a transcript", () => {
    const state = reduceCaptionFeed(feed([["a", 1_000]]), { kind: "active", on: false });
    expect(visibleCaptions(state, 1_100)).toEqual([]);
  });

  it("shows at most BAND_MAX_LINES, keeping the most recent", () => {
    const state = feed([
      ["a", 1_000],
      ["b", 1_100],
      ["c", 1_200],
      ["d", 1_300],
    ]);
    expect(visibleCaptions(state, 1_400).map((e) => e.id)).toEqual(["b", "c", "d"]);
    expect(BAND_MAX_LINES).toBe(3);
  });

  it("expires each line on its OWN clock, not the newest line's", () => {
    // The regression this replaces: the old ticker cleared every line at once,
    // LINGER ms after the LAST one arrived. Here `a` is already stale while
    // `b`, which arrived later, is still perfectly readable.
    const state = feed([
      ["a", 0],
      ["b", 8_000],
    ]);
    const now = LINE_TTL_MS + 1_000; // a expired at LINE_TTL_MS; b at 8000 + TTL
    expect(visibleCaptions(state, now).map((e) => e.id)).toEqual(["b"]);
  });

  it("clears once every line has outlived its TTL", () => {
    const state = feed([["a", 0]]);
    expect(visibleCaptions(state, LINE_TTL_MS)).toEqual([]);
  });
});

describe("nextExpiryAt", () => {
  it("returns the earliest still-live line's expiry so one timer suffices", () => {
    const state = feed([
      ["a", 1_000],
      ["b", 3_000],
    ]);
    expect(nextExpiryAt(state, 3_100)).toBe(1_000 + LINE_TTL_MS);
  });

  it("returns null when nothing is on screen, so no timer is armed at all", () => {
    expect(nextExpiryAt(INITIAL_FEED_STATE, 0)).toBeNull();
    expect(nextExpiryAt(feed([["a", 0]]), LINE_TTL_MS + 1)).toBeNull();
  });
});
