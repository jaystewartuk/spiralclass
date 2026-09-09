import { describe, expect, it } from "vitest";
import {
  buildInsightsPrompt,
  capPerCategory,
  parseInsightsToolInput,
  MAX_INSIGHTS_PER_CATEGORY,
  type Insight,
  type InsightsInput,
} from "@/lib/lesson-notes/insights";

// Phase C — the prompt and the structured-output validation are where the
// quality lives, so they're pure and tested directly (no network).

const BASE: InsightsInput = {
  studentName: "Mira",
  targetLanguage: "es",
  utterances: [
    { speaker: "student", text: "Yo es feliz", atMs: 12000 },
    { speaker: "teacher", text: "Casi — recuerda, con emociones usamos estar", atMs: 14000 },
  ],
  teacherCues: [
    { body: "ser vs estar", done: true },
    { body: "past tense", done: false },
  ],
  studentNotes: [{ body: "Practica el subjuntivo en casa" }],
  en: true,
};

describe("buildInsightsPrompt", () => {
  it("tags each utterance with its atMs and labels the speaker", () => {
    const { user } = buildInsightsPrompt(BASE);
    expect(user).toContain("[12000ms] student: Yo es feliz");
    expect(user).toContain("[14000ms] teacher: Casi");
  });

  it("marks covered cues and lists student instructions", () => {
    const { user } = buildInsightsPrompt(BASE);
    expect(user).toContain("- ser vs estar (covered)");
    expect(user).toContain("- past tense");
    expect(user).toContain("- Practica el subjuntivo en casa");
  });

  it("carries the hard rules: only-provided, never-invent, and pronunciation-from-teacher-only", () => {
    const { system } = buildInsightsPrompt(BASE);
    expect(system).toMatch(/Use ONLY the provided transcript/);
    expect(system).toMatch(/Never invent/i);
    expect(system).toMatch(/Never guess pronunciation from spelling/i);
    expect(system).toContain("emit_insights");
  });

  it("localizes to Spanish for an es teacher", () => {
    const { system, user } = buildInsightsPrompt({ ...BASE, en: false });
    expect(system).toMatch(/Nunca inventes/);
    expect(system).toMatch(/Nunca adivines la pronunciación/);
    expect(user).toContain("Idioma meta");
    expect(user).toContain("Spanish");
  });

  // Regression: the reading language (`en`, the TEACHER's own language) and the
  // target language (what the class is taught IN) are independent facts — same
  // four-language-fields lesson as D-72/D-73, applied to this prompt. Passing
  // the target language as inert context let the model grade a student's
  // target-language grammar by some other language's rules (the reported bug:
  // a Mexican teacher's Spanish class producing an English finding that
  // flagged correct Spanish as incorrect). Both the system rule and the user
  // message must name the target language explicitly as the standard to grade
  // against, independent of which language the summary itself is written in.
  it("names the target language as the correctness standard, independent of the reading language", () => {
    const es = buildInsightsPrompt({ ...BASE, en: false, targetLanguage: "es" });
    expect(es.system).toContain("La clase se imparte en Spanish");
    expect(es.system).toMatch(/juzga cada observación según SUS reglas/);

    const en = buildInsightsPrompt({ ...BASE, en: true, targetLanguage: "fr" });
    expect(en.system).toContain("The lesson is taught in French");
    expect(en.system).toMatch(/judge every finding against ITS grammar/);

    // Reading language Spanish, class taught in English: both facts hold at
    // once, independently.
    const mixed = buildInsightsPrompt({ ...BASE, en: false, targetLanguage: "en" });
    expect(mixed.system).toMatch(/Eres un asistente/);
    expect(mixed.system).toContain("La clase se imparte en English");
  });

  it("falls back to the raw code for a target language outside the registry", () => {
    const { system } = buildInsightsPrompt({
      ...BASE,
      en: false,
      targetLanguage: "zz-not-a-language",
    });
    expect(system).toContain("La clase se imparte en zz-not-a-language");
  });

  it("handles an empty transcript without crashing", () => {
    const { user } = buildInsightsPrompt({ ...BASE, utterances: [] });
    expect(user).toContain("(empty transcript)");
  });

  it("keeps the teacher-signal-only pronunciation rule when no audio scores are present", () => {
    const { system, user } = buildInsightsPrompt(BASE);
    expect(system).toMatch(/Never guess pronunciation from spelling/i);
    expect(user).not.toContain("Pronunciation scores from the audio");
  });

  it("flips the pronunciation rule and lists the scored weak words when Phase D scores are present (audio-grounded)", () => {
    const { system, user } = buildInsightsPrompt({
      ...BASE,
      pronunciation: {
        weakWords: [
          {
            word: "subjuntivo",
            accuracy: 40,
            atMs: 12000,
            phonemes: [{ phoneme: "x", accuracy: 30 }],
          },
        ],
      },
    });
    // Rule switches to score-based; the never-guess-from-spelling rule is gone.
    expect(system).toMatch(/audio pronunciation scores are provided below/);
    expect(system).not.toMatch(/Never guess pronunciation from spelling/i);
    // The weak word, its score, moment, and phoneme appear as evidence.
    expect(user).toContain("Pronunciation scores from the audio");
    expect(user).toContain('"subjuntivo" (40/100) [12000ms]');
    expect(user).toContain("weak sounds: x");
  });
});

describe("parseInsightsToolInput", () => {
  it("maps a valid tool input into Insight rows", () => {
    const out = parseInsightsToolInput({
      insights: [
        {
          category: "grammar",
          summary: "ser/estar with emotions",
          evidence: "Yo es feliz",
          suggestion: "Yo estoy feliz",
          atMs: 12000,
        },
      ],
    });
    expect(out).toEqual([
      {
        category: "grammar",
        summary: "ser/estar with emotions",
        evidence: "Yo es feliz",
        suggestion: "Yo estoy feliz",
        atMs: 12000,
      },
    ]);
  });

  it("drops malformed items but keeps the valid ones", () => {
    const out = parseInsightsToolInput({
      insights: [
        { category: "grammar", summary: "good" },
        { category: "not-a-category", summary: "bad enum" },
        { category: "vocabulary", summary: "" }, // empty summary
        { summary: "missing category" },
        { category: "fluency", summary: "also good", atMs: -5 }, // bad atMs → item dropped
      ],
    });
    expect(out.map((i) => i.summary)).toEqual(["good"]);
    expect(out[0]).toMatchObject({ evidence: null, suggestion: null, atMs: null });
  });

  it("returns [] when insights isn't an array", () => {
    expect(parseInsightsToolInput({})).toEqual([]);
    expect(parseInsightsToolInput({ insights: "nope" })).toEqual([]);
    expect(parseInsightsToolInput(null)).toEqual([]);
  });

  it("caps each category at the max", () => {
    const many = {
      insights: Array.from({ length: 5 }, (_, i) => ({ category: "grammar", summary: `g${i}` })),
    };
    const out = parseInsightsToolInput(many);
    expect(out).toHaveLength(MAX_INSIGHTS_PER_CATEGORY);
    expect(out.map((i) => i.summary)).toEqual(["g0", "g1", "g2"]);
  });
});

describe("capPerCategory", () => {
  it("caps per category independently, preserving order", () => {
    const insights: Insight[] = [
      { category: "grammar", summary: "g1", evidence: null, suggestion: null, atMs: null },
      { category: "fluency", summary: "f1", evidence: null, suggestion: null, atMs: null },
      { category: "grammar", summary: "g2", evidence: null, suggestion: null, atMs: null },
    ];
    const out = capPerCategory(insights, 1);
    expect(out.map((i) => i.summary)).toEqual(["g1", "f1"]);
  });
});
