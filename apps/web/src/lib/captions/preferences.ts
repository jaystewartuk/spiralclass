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

// "both" (original above translation) is gone: the one teacher using it found
// two languages in one place confusing. A browser that stored it reads as the
// default below, since an unknown value degrades field by field.
export type CaptionDisplay = "translation" | "original";
// "s" exists because one size up was right for one student and too much for
// the next: the first said the desktop default was too small to read, so it
// went up a step, and a second then said it covered the teacher's face.
export type CaptionSize = "s" | "m" | "l" | "xl";
// How many subtitles the band holds at once — a ceiling the size can lower
// further (see caption-band.tsx). Separate from the size because the line
// count, not the type, is most of the band's height: a reader can keep large
// letters and still give the video back by asking for one line.
export type CaptionLines = 1 | 2 | 3;
// Where the band sits. "bottom" and "top" are over the video; "below" is a
// strip under the stage that never covers it, the same strip the band already
// becomes when a worksheet owns the stage. Language lessons are the case for
// it: a reader watching the teacher's mouth form a word is reading the lesson
// too, and a band over the lower third of a webcam frame is usually over it.
export type CaptionPosition = "bottom" | "top" | "below";

export type CaptionPreferences = {
  // Whether the band renders on this screen at all. Independent of the room
  // switch: a student who wants to just listen for a while can put the
  // subtitles away without asking her teacher to turn the feature off.
  visible: boolean;
  // Whether the subtitles show while a material or a screen share fills the
  // stage. A second switch rather than a reuse of `visible`, because the two
  // answers differ for the same person in the same lesson: a teacher asked
  // for subtitles over the worksheet, and then said she sometimes wants the
  // worksheet alone. Putting them away there must not also take them off the
  // student's face when the worksheet closes, and must not need the room's
  // switch — which would stop her student's subtitles and the transcript too.
  //
  // `visible` still wins: hidden everywhere is hidden here.
  visibleWithContent: boolean;
  // "translation" is the default because the reader who has never seen this
  // product before has to be able to read the subtitles without first being
  // taught how to read them. "original" is for the viewer deliberately
  // testing herself, one tap away in the settings popover this band owns.
  // A reader who stored a mode keeps it; only a browser with none (or with
  // the retired "both") gets the default.
  display: CaptionDisplay;
  size: CaptionSize;
  lines: CaptionLines;
  position: CaptionPosition;
};

export const DEFAULT_CAPTION_PREFERENCES: CaptionPreferences = {
  visible: true,
  visibleWithContent: true,
  display: "translation",
  size: "m",
  lines: 3,
  position: "bottom",
};

// Are the subtitles showing on this screen right now, given what is on the
// stage? The one answer the band, the control-row button and the keyboard
// shortcut all read, so the button can never say "Hide" while there is
// nothing showing to hide.
export function captionsShownHere(prefs: CaptionPreferences, contentOwnsStage: boolean): boolean {
  return prefs.visible && (!contentOwnsStage || prefs.visibleWithContent);
}

// What "hide" and "show" mean from where the reader is standing.
//
// HIDE is scoped to what she is looking at: over a worksheet it puts the
// subtitles away for worksheets and leaves them alone over the camera; over
// the camera it is the everywhere switch it always was.
//
// SHOW is not scoped. Someone who asks to see subtitles wants to see them
// now, so it clears whichever of the two switches is in the way — including
// the everywhere one, which is otherwise a state a teacher could get into
// and not out of, since her control-row button is the room's switch.
export function toggleCaptionsHerePatch(
  prefs: CaptionPreferences,
  contentOwnsStage: boolean,
): Partial<CaptionPreferences> {
  if (captionsShownHere(prefs, contentOwnsStage)) {
    return contentOwnsStage ? { visibleWithContent: false } : { visible: false };
  }
  return contentOwnsStage ? { visible: true, visibleWithContent: true } : { visible: true };
}

// The localStorage key. Exported because the React wiring in
// use-caption-preferences.ts is the only writer and lives in another file —
// the pure half stays free of browser globals so it is testable in node,
// which is the same split use-caption-ticker.ts and caption-feed.ts use.
export const CAPTION_PREFERENCES_STORAGE_KEY = "spiralclass.captionPreferences";

const DISPLAYS: readonly CaptionDisplay[] = ["translation", "original"];
const SIZES: readonly CaptionSize[] = ["s", "m", "l", "xl"];
const LINES: readonly CaptionLines[] = [1, 2, 3];
const POSITIONS: readonly CaptionPosition[] = ["bottom", "top", "below"];

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
    visibleWithContent:
      typeof obj.visibleWithContent === "boolean"
        ? obj.visibleWithContent
        : DEFAULT_CAPTION_PREFERENCES.visibleWithContent,
    display: DISPLAYS.includes(obj.display as CaptionDisplay)
      ? (obj.display as CaptionDisplay)
      : DEFAULT_CAPTION_PREFERENCES.display,
    size: SIZES.includes(obj.size as CaptionSize)
      ? (obj.size as CaptionSize)
      : DEFAULT_CAPTION_PREFERENCES.size,
    lines: LINES.includes(obj.lines as CaptionLines)
      ? (obj.lines as CaptionLines)
      : DEFAULT_CAPTION_PREFERENCES.lines,
    position: POSITIONS.includes(obj.position as CaptionPosition)
      ? (obj.position as CaptionPosition)
      : DEFAULT_CAPTION_PREFERENCES.position,
  };
}
