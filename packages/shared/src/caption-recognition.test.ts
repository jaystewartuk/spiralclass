import { describe, expect, it } from "vitest";
import {
  MAX_CAPTION_CHARS,
  assignRecognizers,
  baseLanguage,
  buildCaptionLine,
  canRecognizeDuringCall,
  captionLineId,
  chooseTranslationRoute,
  cloudRecognitionRefusal,
  recognitionLocale,
  splitUtterance,
  type RecognitionEnvironment,
  type RecognizerInputs,
} from "./caption-recognition";

describe("recognitionLocale", () => {
  it("composes a regional tag from the teacher's country when the pair is a real variant", () => {
    expect(recognitionLocale("es", "MX")).toBe("es-MX");
    expect(recognitionLocale("es", "ES")).toBe("es-ES");
    expect(recognitionLocale("pt", "BR")).toBe("pt-BR");
    expect(recognitionLocale("en", "GB")).toBe("en-GB");
  });

  it("falls back to the bare language for a pair that is not a variant", () => {
    // A Japanese teacher living in Mexico speaks Japanese, not "ja-MX".
    expect(recognitionLocale("ja", "MX")).toBe("ja");
    expect(recognitionLocale("en", "MX")).toBe("en");
  });

  it("falls back to the bare language when no country is known", () => {
    // A student's speech, or a teacher who has not reached the country step.
    expect(recognitionLocale("es")).toBe("es");
    expect(recognitionLocale("es", null)).toBe("es");
    expect(recognitionLocale("es", "")).toBe("es");
  });

  it("normalises case on both halves", () => {
    expect(recognitionLocale("ES", "mx")).toBe("es-MX");
  });

  it("keeps a tag that is already regional", () => {
    expect(recognitionLocale("es-AR", "MX")).toBe("es-AR");
  });
});

describe("baseLanguage", () => {
  it("strips the region and lower-cases", () => {
    expect(baseLanguage("es-MX")).toBe("es");
    expect(baseLanguage("EN")).toBe("en");
    expect(baseLanguage(" fr ")).toBe("fr");
  });
});

describe("canRecognizeDuringCall", () => {
  const desktopChrome: RecognitionEnvironment = {
    hasRecognition: true,
    hasOnDeviceApi: true,
    chromium: true,
    mobile: false,
  };

  it("is true for desktop Chromium with the on-device API — the measured case", () => {
    expect(canRecognizeDuringCall(desktopChrome)).toBe(true);
  });

  // The regression this whole design exists for: Android Chrome exposes every
  // API and still hears nothing while the call publishes the microphone.
  it("is false on a phone even when every API is present", () => {
    expect(canRecognizeDuringCall({ ...desktopChrome, mobile: true })).toBe(false);
  });

  it("is false for an engine nobody measured, such as Safari", () => {
    expect(canRecognizeDuringCall({ ...desktopChrome, chromium: false })).toBe(false);
  });

  it("is false for a Chromium too old to honour start(track)", () => {
    // It would record the local mic instead of the track it was handed, and
    // caption the teacher's voice as the student's.
    expect(canRecognizeDuringCall({ ...desktopChrome, hasOnDeviceApi: false })).toBe(false);
  });

  it("is false without SpeechRecognition at all", () => {
    expect(canRecognizeDuringCall({ ...desktopChrome, hasRecognition: false })).toBe(false);
  });
});

describe("assignRecognizers", () => {
  const room = (over: Partial<RecognizerInputs> = {}): RecognizerInputs => ({
    captionsOn: true,
    teacher: { present: true, capable: true },
    student: { present: true, capable: true },
    studentConsent: true,
    cloudAvailable: false,
    ...over,
  });
  const phones = {
    teacher: { present: true, capable: false },
    student: { present: true, capable: false },
  };

  it("has each speaker recognised by their own browser when both can", () => {
    expect(assignRecognizers(room())).toEqual({ teacher: "teacher", student: "student" });
  });

  it("has the teacher's desktop recognise a student on a phone", () => {
    expect(assignRecognizers(room({ student: { present: true, capable: false } }))).toEqual({
      teacher: "teacher",
      student: "teacher",
    });
  });

  it("has the student's desktop recognise a teacher on a phone", () => {
    expect(assignRecognizers(room({ teacher: { present: true, capable: false } }))).toEqual({
      teacher: "student",
      student: "student",
    });
  });

  it("assigns nobody when neither browser can recognise and the fallback is not configured", () => {
    expect(assignRecognizers(room(phones))).toEqual({ teacher: null, student: null });
  });

  it("sends each speaker to the cloud from their own device when neither browser can recognise", () => {
    expect(assignRecognizers(room({ ...phones, cloudAvailable: true }))).toEqual({
      teacher: "cloud",
      student: "cloud",
    });
  });

  it("never uses the cloud for a speaker any browser in the room can recognise", () => {
    // The whole matrix of who can: one capable browser anywhere means no
    // paid minutes, for either speaker.
    for (const teacherCapable of [true, false]) {
      for (const studentCapable of [true, false]) {
        if (!teacherCapable && !studentCapable) continue;
        const assignment = assignRecognizers(
          room({
            cloudAvailable: true,
            teacher: { present: true, capable: teacherCapable },
            student: { present: true, capable: studentCapable },
          }),
        );
        expect(assignment.teacher).not.toBe("cloud");
        expect(assignment.student).not.toBe("cloud");
        expect(assignment.teacher).not.toBeNull();
        expect(assignment.student).not.toBeNull();
      }
    }
  });

  it("never sends the student to the cloud without her consent", () => {
    expect(
      assignRecognizers(room({ ...phones, cloudAvailable: true, studentConsent: false })),
    ).toEqual({ teacher: "cloud", student: null });
  });

  it("never uses the cloud while the switch is off or someone is missing", () => {
    expect(assignRecognizers(room({ ...phones, cloudAvailable: true, captionsOn: false }))).toEqual(
      { teacher: null, student: null },
    );
    expect(
      assignRecognizers(
        room({
          cloudAvailable: true,
          teacher: { present: true, capable: false },
          student: { present: false, capable: false },
        }),
      ),
    ).toEqual({ teacher: null, student: null });
  });

  it("never captions the student without consent, whoever could recognise her", () => {
    expect(assignRecognizers(room({ studentConsent: false }))).toEqual({
      teacher: "teacher",
      student: null,
    });
    expect(
      assignRecognizers(
        room({ studentConsent: false, student: { present: true, capable: false } }),
      ),
    ).toEqual({ teacher: "teacher", student: null });
  });

  it("assigns nobody while the teacher's switch is off", () => {
    expect(assignRecognizers(room({ captionsOn: false }))).toEqual({
      teacher: null,
      student: null,
    });
  });

  it("assigns nobody while either person is missing from the room", () => {
    expect(assignRecognizers(room({ student: { present: false, capable: true } }))).toEqual({
      teacher: null,
      student: null,
    });
    expect(assignRecognizers(room({ teacher: { present: false, capable: true } }))).toEqual({
      teacher: null,
      student: null,
    });
  });
});

describe("chooseTranslationRoute", () => {
  it("skips translation when both sides share a language, whatever the region", () => {
    expect(chooseTranslationRoute("es-MX", "es", "available")).toBe("none");
    expect(chooseTranslationRoute("en", "en", null)).toBe("none");
  });

  it("uses the device when its translator has, or can fetch, the pair", () => {
    expect(chooseTranslationRoute("es", "en", "available")).toBe("device");
    expect(chooseTranslationRoute("es", "en", "downloadable")).toBe("device");
    expect(chooseTranslationRoute("es", "en", "downloading")).toBe("device");
  });

  it("uses the server when the device has no translator or not this pair", () => {
    expect(chooseTranslationRoute("es", "en", null)).toBe("server");
    expect(chooseTranslationRoute("es", "en", "unavailable")).toBe("server");
    expect(chooseTranslationRoute("es", "en", "something-new")).toBe("server");
  });
});

describe("splitUtterance", () => {
  it("returns a short utterance as one normalised piece", () => {
    expect(splitUtterance("  hola   qué tal  ")).toEqual(["hola qué tal"]);
  });

  it("returns nothing for blank input", () => {
    expect(splitUtterance("   ")).toEqual([]);
  });

  it("splits at sentence ends first", () => {
    expect(splitUtterance("Uno dos. Tres cuatro.", 12)).toEqual(["Uno dos.", "Tres cuatro."]);
  });

  it("splits at spaces when no sentence end fits", () => {
    expect(splitUtterance("uno dos tres cuatro", 9)).toEqual(["uno dos", "tres", "cuatro"]);
  });

  it("cuts mid-word only when a word alone exceeds the limit", () => {
    expect(splitUtterance("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("never returns a piece over the route's limit", () => {
    const long = "palabra ".repeat(400);
    const pieces = splitUtterance(long);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS);
    expect(pieces.join(" ")).toBe(long.trim());
  });
});

describe("buildCaptionLine", () => {
  const base = {
    translated: "How are you?",
    source: "¿Cómo estás?",
    sourceLanguage: "es",
    targetLanguage: "en",
    speakerIdentity: "teacher-1",
    listenerIdentity: "student-1",
    seq: 3,
    now: 1_000,
  };

  it("addresses the line to the listener and carries both texts and languages", () => {
    expect(buildCaptionLine(base)).toEqual({
      t: "line",
      for: "student-1",
      id: "teacher-1:1000-3",
      text: "How are you?",
      src: "¿Cómo estás?",
      from: "teacher-1",
      lang: "en",
      srcLang: "es",
    });
  });

  it("omits src when the translation is the source, ignoring case", () => {
    const line = buildCaptionLine({ ...base, translated: "hola", source: "Hola" });
    expect(line.src).toBeUndefined();
  });

  it("omits src when nothing was recognised verbatim", () => {
    expect(buildCaptionLine({ ...base, source: "  " }).src).toBeUndefined();
  });
});

describe("captionLineId", () => {
  it("separates two speakers finalising in the same millisecond", () => {
    expect(captionLineId("a", 5, 0)).not.toBe(captionLineId("b", 5, 0));
  });

  it("separates two lines from one speaker in the same millisecond", () => {
    expect(captionLineId("a", 5, 0)).not.toBe(captionLineId("a", 5, 1));
  });
});

describe("cloudRecognitionRefusal", () => {
  const teacher = (attrs: Record<string, string> = {}) => ({
    identity: "t1",
    attributes: { captionsOn: "true", captionsAsr: "0", ...attrs },
  });
  const student = (attrs: Record<string, string> = {}) => ({
    identity: "s1",
    attributes: { captionsAsr: "0", ...attrs },
  });
  const verdict = (participants: { identity: string; attributes: Record<string, string> }[]) =>
    cloudRecognitionRefusal({ participants, callerIdentity: "s1", teacherIdentity: "t1" });

  it("allows a room of two phones with the teacher's switch on", () => {
    expect(verdict([teacher(), student()])).toBeNull();
    // A participant that never published the attribute reads as unable.
    expect(verdict([teacher(), { identity: "s1", attributes: {} }])).toBeNull();
  });

  it("refuses when any browser in the room can recognise", () => {
    expect(verdict([teacher({ captionsAsr: "1" }), student()])).toBe("browser-can-recognise");
    expect(verdict([teacher(), student({ captionsAsr: "1" })])).toBe("browser-can-recognise");
  });

  it("refuses a caller who is not in the room, or is alone in it", () => {
    expect(verdict([teacher()])).toBe("caller-absent");
    expect(verdict([student()])).toBe("alone");
  });

  it("refuses while the teacher's switch is off, trusting only her attribute", () => {
    expect(verdict([teacher({ captionsOn: "false" }), student()])).toBe("captions-off");
    // The student setting the switch on herself counts for nothing.
    expect(verdict([teacher({ captionsOn: "false" }), student({ captionsOn: "true" })])).toBe(
      "captions-off",
    );
  });
});
