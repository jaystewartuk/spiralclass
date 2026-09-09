import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTION_PREFERENCES, parseCaptionPreferences } from "@/lib/captions/preferences";

// These preferences are read from localStorage, which is to say from a place
// any earlier build of the app (or the user's own devtools) may have written.
// The contract asserted here is FIELD-WISE degradation: one bad value must
// never cost the reader the other settings she chose.

describe("parseCaptionPreferences", () => {
  it("defaults to the translation alone, medium, visible", () => {
    // The default is the product decision, and it is aimed at the reader who
    // has no stored preference yet: a first-time viewer, who must be able to
    // read the band without being told how. "both" is the richer mode and is
    // one tap away for the student who wants it. See preferences.ts.
    expect(DEFAULT_CAPTION_PREFERENCES).toEqual({
      visible: true,
      display: "translation",
      size: "m",
    });
  });

  it("falls back to the defaults for absent, unparseable and non-object storage", () => {
    expect(parseCaptionPreferences(null)).toEqual(DEFAULT_CAPTION_PREFERENCES);
    expect(parseCaptionPreferences("")).toEqual(DEFAULT_CAPTION_PREFERENCES);
    expect(parseCaptionPreferences("{not json")).toEqual(DEFAULT_CAPTION_PREFERENCES);
    expect(parseCaptionPreferences("42")).toEqual(DEFAULT_CAPTION_PREFERENCES);
    expect(parseCaptionPreferences("null")).toEqual(DEFAULT_CAPTION_PREFERENCES);
  });

  it("round-trips a fully valid stored preference set", () => {
    const stored = { visible: false, display: "original", size: "xl" };
    expect(parseCaptionPreferences(JSON.stringify(stored))).toEqual(stored);
  });

  it("keeps the valid fields when one is invalid", () => {
    // A reader who set extra-large text and then hit a build that renamed a
    // display mode must not silently lose her text size too.
    const stored = { visible: false, display: "sideways", size: "xl" };
    expect(parseCaptionPreferences(JSON.stringify(stored))).toEqual({
      visible: false,
      display: "translation",
      size: "xl",
    });
  });

  it("ignores unknown fields from a future or hand-edited blob", () => {
    const stored = { visible: true, display: "translation", size: "l", position: "top" };
    expect(parseCaptionPreferences(JSON.stringify(stored))).toEqual({
      visible: true,
      display: "translation",
      size: "l",
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
