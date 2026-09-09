import { describe, expect, it } from "vitest";

import { buildIntroCoachPrompt, parseIntroCoachFeedback } from "@/lib/intro-video/coach";

// AI intro-video coach (D-73, Layer 3). The prompt is built purely (no network)
// and the model's JSON is parsed defensively, so both are unit-tested here; the
// network call itself (generateIntroCoachFeedback) is exercised via its
// IntroCoachUnavailableError degrade path in the pipeline tests.

describe("buildIntroCoachPrompt", () => {
  it("writes a Spanish prompt embedding the transcript and duration when en=false", () => {
    const { system, user } = buildIntroCoachPrompt({
      transcript: "Hola, soy Mira y doy clases de inglés.",
      durationSec: 42,
      en: false,
    });
    expect(system).toContain("JSON estricto");
    expect(system).toContain("para quién son las clases");
    expect(user).toContain("Hola, soy Mira y doy clases de inglés.");
    expect(user).toContain("42 segundos");
  });

  it("writes an English prompt and states unknown length when duration is null", () => {
    const { system, user } = buildIntroCoachPrompt({
      transcript: "Hi, I'm Mira.",
      durationSec: null,
      en: true,
    });
    expect(system).toContain("STRICT JSON");
    expect(system).toContain("who the classes are for");
    expect(user).toContain("Hi, I'm Mira.");
    expect(user).toContain("Video length: unknown.");
  });

  it("substitutes a placeholder for an empty transcript rather than leaving it blank", () => {
    const { user } = buildIntroCoachPrompt({ transcript: "   ", durationSec: 10, en: true });
    expect(user).toContain("(no speech detected)");
  });
});

describe("parseIntroCoachFeedback", () => {
  it("parses a plain JSON object", () => {
    const out = parseIntroCoachFeedback(
      JSON.stringify({
        overall: "Warm and clear.",
        strengths: ["Good energy", "Clear ask"],
        improvements: ["Say who it's for"],
      }),
    );
    expect(out).toEqual({
      overall: "Warm and clear.",
      strengths: ["Good energy", "Clear ask"],
      improvements: ["Say who it's for"],
    });
  });

  it("tolerates a fenced ```json block", () => {
    const out = parseIntroCoachFeedback(
      '```json\n{"overall":"Nice.","strengths":[],"improvements":["Shorten it"]}\n```',
    );
    expect(out).toEqual({ overall: "Nice.", strengths: [], improvements: ["Shorten it"] });
  });

  it("drops non-string / blank array entries", () => {
    const out = parseIntroCoachFeedback(
      JSON.stringify({ overall: "Ok", strengths: ["A", "", 3, null, "B"], improvements: [] }),
    );
    expect(out).toEqual({ overall: "Ok", strengths: ["A", "B"], improvements: [] });
  });

  it("returns null for malformed JSON", () => {
    expect(parseIntroCoachFeedback("not json {")).toBeNull();
  });

  it("returns null when nothing usable is present", () => {
    expect(
      parseIntroCoachFeedback(JSON.stringify({ overall: "", strengths: [], improvements: [] })),
    ).toBeNull();
    expect(parseIntroCoachFeedback(JSON.stringify({ foo: "bar" }))).toBeNull();
  });
});
