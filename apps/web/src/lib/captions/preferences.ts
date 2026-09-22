// How THIS viewer wants subtitles rendered on THEIR screen.
//
// Distinct from the teacher's room-wide captions switch (D-27), and the
// distinction is the point. That switch decides whether anyone's speech is
// transcribed at all — a privacy and cost decision, correctly hers alone.
// What size the letters are, whether the original sits above the
// translation, and whether the band is covering the person's face are
// decisions about ONE reader's screen, and the student had no say in any of
// them: she received subtitles at one fixed size, in one fixed form, and
// could not move or dismiss them.
//
// Persisted per browser rather than per account: it is a rendering
// preference tied to the screen someone is reading on (a phone in a cafe and
// a desktop want different sizes), it must survive a page reload mid-lesson,
// and it has no business round-tripping through the database.

export type CaptionDisplay = "both" | "translation" | "original";
export type CaptionSize = "m" | "l" | "xl";

export type CaptionPreferences = {
  // Whether the band renders on this screen at all. Independent of the room
  // switch: a student who wants to just listen for a while can put the
  // subtitles away without asking her teacher to turn the feature off.
  visible: boolean;
  // "translation" is the default because the reader who has never seen this
  // product before has to be able to read the subtitles without first being
  // taught how to read them. Two languages stacked is the richer view for a
  // lesson already under way, and the wrong first thing to put in front of
  // someone meeting the platform on an introductory call: twice the text,
  // half of it in the language they came here not to have yet.
  //
  // The asymmetry is the whole argument. A student who wants the source
  // sentence is one tap away in the settings popover this band owns, and she
  // will find it, because she is here every week. A prospective student on a
  // twenty-minute call cannot be talked through a popover while somebody is
  // selling to her — so the default has to be the mode that needs no
  // explanation, and the richer mode has to be the one you opt into.
  //
  // This only ever reaches a browser with NO stored preference: parse below
  // degrades field by field, so a reader who has already chosen a mode keeps
  // the one she chose. The people it actually reaches are new viewers.
  //
  // "original" remains for the viewer deliberately testing herself.
  display: CaptionDisplay;
  size: CaptionSize;
};

export const DEFAULT_CAPTION_PREFERENCES: CaptionPreferences = {
  visible: true,
  display: "translation",
  size: "m",
};

// The localStorage key. Exported because the React wiring in
// use-caption-preferences.ts is the only writer and lives in another file —
// the pure half stays free of browser globals so it is testable in node,
// which is the same split use-caption-ticker.ts and caption-feed.ts use.
export const CAPTION_PREFERENCES_STORAGE_KEY = "spiralclass.captionPreferences";

const DISPLAYS: readonly CaptionDisplay[] = ["both", "translation", "original"];
const SIZES: readonly CaptionSize[] = ["m", "l", "xl"];

// Parse whatever is in storage into a valid preference set, field by field.
// A stored blob from an older build (or a hand-edited one) must degrade to
// the defaults for the fields it gets wrong and keep the ones it gets right —
// throwing away a reader's text size because a later build added a field
// would be a worse outcome than any of the values being wrong.
export function parseCaptionPreferences(raw: string | null): CaptionPreferences {
  if (!raw) return DEFAULT_CAPTION_PREFERENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_CAPTION_PREFERENCES;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_CAPTION_PREFERENCES;
  const obj = parsed as Record<string, unknown>;
  return {
    visible: typeof obj.visible === "boolean" ? obj.visible : DEFAULT_CAPTION_PREFERENCES.visible,
    display: DISPLAYS.includes(obj.display as CaptionDisplay)
      ? (obj.display as CaptionDisplay)
      : DEFAULT_CAPTION_PREFERENCES.display,
    size: SIZES.includes(obj.size as CaptionSize)
      ? (obj.size as CaptionSize)
      : DEFAULT_CAPTION_PREFERENCES.size,
  };
}
