import { describe, expect, it } from "vitest";
import { buildCaptionLine, captionLineId } from "./caption-line";
import type { SpeakerDirection } from "./direction";

// The Agent is the only component that ever holds all four facts a
// language-lesson subtitle needs, so what it fails to attach here is gone.
// These assert the two rules that are easy to get quietly wrong.

const teacherSpeaking: SpeakerDirection = {
  source: "es",
  target: "en",
  listenerIdentity: "student-1",
};

describe("buildCaptionLine", () => {
  it("attaches the source text, the speaker and both language codes", () => {
    expect(
      buildCaptionLine({
        translated: "How are you?",
        source: "¿Cómo estás?",
        direction: teacherSpeaking,
        speakerIdentity: "teacher-1",
        seq: 0,
        now: 1_700_000_000_000,
      }),
    ).toEqual({
      t: "line",
      for: "student-1",
      id: "1700000000000-0",
      text: "How are you?",
      src: "¿Cómo estás?",
      from: "teacher-1",
      lang: "en",
      srcLang: "es",
    });
  });

  const build = (translated: string, source: string) =>
    buildCaptionLine({
      translated,
      source,
      direction: teacherSpeaking,
      speakerIdentity: "teacher-1",
      seq: 0,
      now: 0,
    });

  it("omits `src` when the translation came back unchanged", () => {
    // The translation prompt tells the model to return already-target-language
    // text unchanged, so this is routine — the teacher dropping into the
    // student's own language for a sentence. Sending it would stack the same
    // words twice in the band's dual-line layout, which reads as a bug.
    expect(build("Good morning", "Good morning").src).toBeUndefined();
  });

  it("omits `src` when the only difference is capitalisation or padding", () => {
    // The model routinely capitalises a sentence the ASR did not. That is not
    // two languages, and showing it as two lines would be nonsense.
    expect(build("Good morning", "good morning").src).toBeUndefined();
    expect(build("Good morning", "  Good morning  ").src).toBeUndefined();
  });

  it("keeps `src` whenever it genuinely differs", () => {
    expect(build("Good morning", "Buenos días").src).toBe("Buenos días");
  });

  it("omits `src` for an empty transcript rather than sending a blank line", () => {
    expect(build("Good morning", "   ").src).toBeUndefined();
  });
});

describe("captionLineId", () => {
  it("distinguishes two lines finalized in the same millisecond", () => {
    // The receiver keys its feed by this id so a redelivery REPLACES. A
    // clock-only id would collide whenever both people talk over each other,
    // and one of the two lines would silently vanish.
    expect(captionLineId(1_000, 0)).not.toBe(captionLineId(1_000, 1));
  });
});
