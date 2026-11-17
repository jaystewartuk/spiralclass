import { describe, expect, it } from "vitest";

import { classSpokenLanguages, lessonLanguage } from "@/lib/transcription/language";

describe("lessonLanguage", () => {
  it("is the subject she teaches, not Spanish, for a teacher of French", () => {
    expect(lessonLanguage({ targetLanguage: "fr", teachingLanguage: "en" })).toBe("fr");
  });

  it("falls back to the language she teaches in while her subject is unset", () => {
    expect(lessonLanguage({ targetLanguage: null, teachingLanguage: "de" })).toBe("de");
  });
});

describe("classSpokenLanguages", () => {
  const booking = {
    teacherLanguageOverride: null,
    studentLanguageOverride: null,
    teacher: { teachingLanguage: "fr" },
    student: { nativeLanguage: "en" },
  };

  it("is each participant's own language by default", () => {
    expect(classSpokenLanguages(booking)).toEqual({ teacher: "fr", student: "en" });
  });

  it("takes this class's override when the teacher set one", () => {
    expect(
      classSpokenLanguages({
        ...booking,
        teacherLanguageOverride: "it",
        studentLanguageOverride: "pt",
      }),
    ).toEqual({ teacher: "it", student: "pt" });
  });
});
