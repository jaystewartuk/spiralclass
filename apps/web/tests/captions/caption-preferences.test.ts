import { describe, expect, it } from "vitest";
import {
  captionsShownHere,
  DEFAULT_CAPTION_PREFERENCES,
  parseCaptionPreferences,
  toggleCaptionsHerePatch,
} from "@/lib/captions/preferences";

// These preferences are read from localStorage, which is to say from a place
// any earlier build of the app (or the user's own devtools) may have written.
// The contract asserted here is FIELD-WISE degradation: one bad value must
// never cost the reader the other settings she chose.

describe("parseCaptionPreferences", () => {
  it("defaults to the translation alone, medium, three lines, at the bottom, visible", () => {
    // The default is the product decision, and it is aimed at the reader who
    // has no stored preference yet: a first-time viewer, who must be able to
    // read the band without being told how. See preferences.ts.
    expect(DEFAULT_CAPTION_PREFERENCES).toEqual({
      visible: true,
      visibleWithContent: true,
      display: "translation",
      size: "m",
      lines: 3,
      position: "bottom",
    });
  });

  it("keeps subtitles on with materials for a reader who stored her choices before that switch existed", () => {
    // Everyone with a stored preference today has no `visibleWithContent`.
    // Reading its absence as "hidden" would take the subtitles this change
    // adds away from exactly the people who already use them.
    const stored = { visible: true, display: "original", size: "l" };
    expect(parseCaptionPreferences(JSON.stringify(stored))).toEqual({
      ...stored,
      visibleWithContent: true,
      lines: 3,
      position: "bottom",
    });
    expect(
      parseCaptionPreferences(JSON.stringify({ ...stored, visibleWithContent: "no" }))
        .visibleWithContent,
    ).toBe(true);
    expect(
      parseCaptionPreferences(JSON.stringify({ ...stored, visibleWithContent: false }))
        .visibleWithContent,
    ).toBe(false);
  });

  it("falls back to the defaults for absent, unparseable and non-object storage", () => {
    expect(parseCaptionPreferences(null)).toEqual(DEFAULT_CAPTION_PREFERENCES);
    expect(parseCaptionPreferences("")).toEqual(DEFAULT_CAPTION_PREFERENCES);
    expect(parseCaptionPreferences("{not json")).toEqual(DEFAULT_CAPTION_PREFERENCES);
    expect(parseCaptionPreferences("42")).toEqual(DEFAULT_CAPTION_PREFERENCES);
    expect(parseCaptionPreferences("null")).toEqual(DEFAULT_CAPTION_PREFERENCES);
  });

  it("round-trips a fully valid stored preference set", () => {
    const stored = {
      visible: false,
      visibleWithContent: false,
      display: "original",
      size: "xl",
      lines: 1,
      position: "below",
    };
    expect(parseCaptionPreferences(JSON.stringify(stored))).toEqual(stored);
  });

  it("round-trips the small size, every line count and every position", () => {
    for (const size of ["s", "m", "l", "xl"] as const) {
      expect(parseCaptionPreferences(JSON.stringify({ size })).size).toBe(size);
    }
    for (const lines of [1, 2, 3] as const) {
      expect(parseCaptionPreferences(JSON.stringify({ lines })).lines).toBe(lines);
    }
    for (const position of ["bottom", "top", "below"] as const) {
      expect(parseCaptionPreferences(JSON.stringify({ position })).position).toBe(position);
    }
  });

  it("keeps the valid fields when one is invalid", () => {
    // A reader who set extra-large text and then hit a build that renamed a
    // display mode must not silently lose her text size too.
    const stored = { visible: false, display: "sideways", size: "xl", position: "top" };
    expect(parseCaptionPreferences(JSON.stringify(stored))).toEqual({
      visible: false,
      visibleWithContent: true,
      display: "translation",
      size: "xl",
      lines: 3,
      position: "top",
    });
  });

  it("discards a line count or position it does not know, for the default", () => {
    // "2" is a string, 4 and 0 are out of range, "middle" was never a
    // position: a band parked mid-face is the thing positions exist to avoid.
    for (const lines of ["2", 4, 0, null]) {
      expect(parseCaptionPreferences(JSON.stringify({ lines })).lines).toBe(3);
    }
    for (const position of ["middle", "left", 1]) {
      expect(parseCaptionPreferences(JSON.stringify({ position })).position).toBe("bottom");
    }
  });

  it("reads the retired 'both' mode as the translation alone and keeps the rest", () => {
    // Original-above-translation was removed (one line, never two); a browser
    // that stored it must neither break nor lose its size.
    const stored = { visible: true, visibleWithContent: true, display: "both", size: "l" };
    expect(parseCaptionPreferences(JSON.stringify(stored))).toEqual({
      ...stored,
      display: "translation",
      lines: 3,
      position: "bottom",
    });
  });

  it("ignores unknown fields from a future or hand-edited blob", () => {
    const stored = { visible: true, display: "translation", size: "l", opacity: 0.5 };
    expect(parseCaptionPreferences(JSON.stringify(stored))).toEqual({
      visible: true,
      visibleWithContent: true,
      display: "translation",
      size: "l",
      lines: 3,
      position: "bottom",
    });
  });

  it("discards a wrong-typed visible for the default rather than coercing it", () => {
    // Both of these are checked because JS coercion would read them in
    // OPPOSITE directions — the string "false" is truthy and the number 0 is
    // falsy — so a coercing parser would have the same corrupt value mean
    // "shown" in one build and "hidden" in the next. Type-checking the field
    // and falling back to the default gives one answer either way.
    expect(parseCaptionPreferences(JSON.stringify({ visible: "false" })).visible).toBe(true);
    expect(parseCaptionPreferences(JSON.stringify({ visible: 0 })).visible).toBe(true);
  });
});

// Two switches, and what each control means depends on what the reader is
// looking at. These are the rules the band, the student's button, her
// shortcut and the "hidden" pill all share.
describe("showing and hiding from where the reader is", () => {
  const on = DEFAULT_CAPTION_PREFERENCES;

  it("shows subtitles over the camera and over a material by default", () => {
    expect(captionsShownHere(on, false)).toBe(true);
    expect(captionsShownHere(on, true)).toBe(true);
  });

  it("hiding over a material leaves the subtitles over the camera alone", () => {
    // The teacher's request: sometimes the worksheet alone. Closing the
    // worksheet must bring her student's subtitles straight back.
    const patch = toggleCaptionsHerePatch(on, true);
    expect(patch).toEqual({ visibleWithContent: false });
    const next = { ...on, ...patch };
    expect(captionsShownHere(next, true)).toBe(false);
    expect(captionsShownHere(next, false)).toBe(true);
  });

  it("hiding over the camera hides them everywhere, as it always did", () => {
    const patch = toggleCaptionsHerePatch(on, false);
    expect(patch).toEqual({ visible: false });
    const next = { ...on, ...patch };
    expect(captionsShownHere(next, false)).toBe(false);
    expect(captionsShownHere(next, true)).toBe(false);
  });

  it("showing over a material clears whichever switch is in the way", () => {
    // Hidden everywhere AND hidden with materials: one tap on "show" with a
    // worksheet up has to actually show them, not flip the wrong switch and
    // leave the reader looking at nothing.
    const hidden = { ...on, visible: false, visibleWithContent: false };
    const next = { ...hidden, ...toggleCaptionsHerePatch(hidden, true) };
    expect(captionsShownHere(next, true)).toBe(true);
  });

  it("showing over the camera does not undo a standing choice about materials", () => {
    const hidden = { ...on, visible: false, visibleWithContent: false };
    const next = { ...hidden, ...toggleCaptionsHerePatch(hidden, false) };
    expect(captionsShownHere(next, false)).toBe(true);
    expect(next.visibleWithContent).toBe(false);
  });
});
