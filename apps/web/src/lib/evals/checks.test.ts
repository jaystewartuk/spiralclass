import { describe, expect, it } from "vitest";
import type { Insight } from "@/lib/lesson-notes/insights";
import type { HomeworkReviewCase, LessonInsightsCase } from "./cases";
import { checkHomeworkReview, checkLessonInsights, normalize } from "./checks";

// The deterministic half of the model evals (D-201). Each check is a prompt
// rule as a function; these pin what each one catches and what it lets pass.

const lesson: LessonInsightsCase = {
  surface: "lesson-insights",
  name: "fixture",
  about: "fixture",
  input: {
    studentName: "Sam",
    targetLanguage: "es",
    outputLanguage: "English",
    utterances: [
      { speaker: "teacher", text: "¿Qué tal?", atMs: 0 },
      { speaker: "student", text: "Yo soy muy cansado hoy.", atMs: 4200 },
      { speaker: "teacher", text: "Estoy cansado — con estar.", atMs: 9100 },
      { speaker: "student", text: "Mi hermana es en Madrid.", atMs: 15300 },
    ],
    teacherCues: [{ body: "ser vs estar", done: true }],
    studentNotes: [],
  },
  expect: { categories: ["grammar"], mustMention: ["estar"], maxFindings: 2 },
};

const finding = (over: Partial<Insight> = {}): Insight => ({
  category: "grammar",
  summary: "Uses ser for a temporary state",
  evidence: "yo soy muy cansado",
  suggestion: "estoy cansado — estar for how you feel now",
  atMs: 4200,
  ...over,
});

const byId = (checks: { id: string; ok: boolean; detail: string | null }[]) =>
  Object.fromEntries(checks.map((c) => [c.id, c]));

describe("normalize", () => {
  it("ignores case, punctuation and spacing but keeps accents", () => {
    expect(normalize("  «Estoy  cansado.» ")).toBe("estoy cansado");
    expect(normalize("música")).not.toBe(normalize("musica"));
  });
});

describe("checkLessonInsights", () => {
  it("passes a grounded, bounded finding on every check", () => {
    const checks = byId(checkLessonInsights(lesson, [finding()]));
    expect(Object.values(checks).every((c) => c.ok)).toBe(true);
    expect(Object.keys(checks).sort()).toEqual([
      "cap-per-category",
      "categories-allowed",
      "conservative",
      "evidence-present",
      "evidence-quoted",
      "must-mention",
      "timestamp-anchored",
    ]);
  });

  it("fails evidence lifted from the teacher's turn or paraphrased", () => {
    const teacherQuote = byId(checkLessonInsights(lesson, [finding({ evidence: "con estar" })]));
    expect(teacherQuote["evidence-quoted"]!.ok).toBe(false);
    const paraphrase = byId(checkLessonInsights(lesson, [finding({ evidence: "soy cansada" })]));
    expect(paraphrase["evidence-quoted"]!.ok).toBe(false);
  });

  it("fails a finding with no evidence, and one whose timestamp is not the cited line", () => {
    const none = byId(checkLessonInsights(lesson, [finding({ evidence: null })]));
    expect(none["evidence-present"]!.ok).toBe(false);
    const drift = byId(checkLessonInsights(lesson, [finding({ atMs: 15300 })]));
    expect(drift["timestamp-anchored"]!.ok).toBe(false);
    const missing = byId(checkLessonInsights(lesson, [finding({ atMs: null })]));
    expect(missing["timestamp-anchored"]!.ok).toBe(false);
  });

  it("fails more findings than the case allows, a category it gives no grounds for, and a missing mention", () => {
    const many = byId(checkLessonInsights(lesson, [finding(), finding(), finding()]));
    expect(many["conservative"]!.ok).toBe(false);
    expect(many["cap-per-category"]!.ok).toBe(true); // three is the cap, not over it
    const offTopic = byId(checkLessonInsights(lesson, [finding({ category: "fluency" })]));
    expect(offTopic["categories-allowed"]!.ok).toBe(false);
    const silent = byId(
      checkLessonInsights(lesson, [finding({ suggestion: "use the other verb", summary: "verb" })]),
    );
    expect(silent["must-mention"]!.ok).toBe(false);
  });

  it("holds pronunciation findings to the teacher signal when there is no audio", () => {
    const pron = finding({ category: "pronunciation", summary: "Weak r" });
    const noSignal: LessonInsightsCase = {
      ...lesson,
      input: {
        ...lesson.input,
        teacherCues: [],
        utterances: lesson.input.utterances.filter((u) => u.speaker === "student"),
      },
      expect: undefined,
    };
    expect(byId(checkLessonInsights(noSignal, [pron]))["pronunciation-grounded"]!.ok).toBe(false);
    // With a teacher cue present the text check cannot tell, so it does not run.
    expect(byId(checkLessonInsights(lesson, [pron]))["pronunciation-grounded"]).toBeUndefined();
  });

  it("holds pronunciation findings to the scored words when audio scores exist", () => {
    const scored: LessonInsightsCase = {
      ...lesson,
      input: {
        ...lesson.input,
        pronunciation: { weakWords: [{ word: "hermana", accuracy: 40, atMs: 15300 }] },
      },
      expect: undefined,
    };
    const onWord = finding({
      category: "pronunciation",
      evidence: "hermana",
      atMs: 15300,
    });
    const offWord = finding({ category: "pronunciation", evidence: "yo soy muy cansado" });
    expect(byId(checkLessonInsights(scored, [onWord]))["pronunciation-grounded"]!.ok).toBe(true);
    expect(byId(checkLessonInsights(scored, [onWord]))["evidence-quoted"]!.ok).toBe(true);
    expect(byId(checkLessonInsights(scored, [offWord]))["pronunciation-grounded"]!.ok).toBe(false);
  });

  it("reports the per-category cap moving", () => {
    const four = [finding(), finding(), finding(), finding()];
    expect(byId(checkLessonInsights(lesson, four))["cap-per-category"]!.ok).toBe(false);
  });
});

const homework: HomeworkReviewCase = {
  surface: "homework-review",
  name: "fixture",
  about: "fixture",
  input: {
    assignmentTitle: "Preséntate",
    assignmentInstructions: null,
    materialExcerpt: null,
    attemptText: "Me gusta mucho el musica y los libros.",
    attachmentTexts: [{ fileName: "notes.txt", text: "Tengo veintidós años." }],
    teacherInstructions: null,
    outputLanguage: "English",
  },
  languageFocused: false,
  expect: { mustMention: ["música"], scoreRange: [5, 9] },
};

const review = {
  corrections: ['"el musica" should be "la música" — música is feminine.'],
  strengths: ["Clear structure."],
  weaknesses: ["Short."],
  grammarNotes: null,
  suggestedFeedback: "Nice start, Dana.",
  suggestedScore: 7,
};

describe("checkHomeworkReview", () => {
  it("passes a grounded review and reports which checks ran", () => {
    const checks = byId(checkHomeworkReview(homework, review));
    expect(Object.values(checks).every((c) => c.ok)).toBe(true);
    expect(Object.keys(checks).sort()).toEqual([
      "concise",
      "grammar-notes-gated",
      "must-mention",
      "parsed",
      "quotes-grounded",
      "score-in-range",
    ]);
  });

  it("is a single failed check when nothing usable came back", () => {
    expect(checkHomeworkReview(homework, null)).toEqual([
      { id: "parsed", ok: false, detail: "no usable review came back" },
    ]);
  });

  it("fails a quotation the student never wrote, and accepts one from an attachment", () => {
    const invented = byId(
      checkHomeworkReview(homework, {
        ...review,
        corrections: ['You wrote "me gustan los musicas" — check agreement.'],
      }),
    );
    expect(invented["quotes-grounded"]!.ok).toBe(false);
    const attached = byId(
      checkHomeworkReview(homework, {
        ...review,
        strengths: ['"Tengo veintidós años" is exactly right.'],
      }),
    );
    expect(attached["quotes-grounded"]!.ok).toBe(true);
    // A bullet that quotes the slip and then the fix is grounded by the slip.
    const slipAndFix = byId(
      checkHomeworkReview(homework, {
        ...review,
        corrections: ['"el musica" → "la música".'],
      }),
    );
    expect(slipAndFix["quotes-grounded"]!.ok).toBe(true);
  });

  it("fails grammar notes on a non-language assignment and skips that check on language practice", () => {
    const noted = { ...review, grammarNotes: ["Gender agreement."] };
    expect(byId(checkHomeworkReview(homework, noted))["grammar-notes-gated"]!.ok).toBe(false);
    const practice = byId(checkHomeworkReview({ ...homework, languageFocused: true }, noted));
    expect(practice["grammar-notes-gated"]).toBeUndefined();
  });

  it("fails a missing or out-of-range score, and a review that is not bullet points", () => {
    expect(
      byId(checkHomeworkReview(homework, { ...review, suggestedScore: null }))["score-in-range"]!
        .ok,
    ).toBe(false);
    expect(
      byId(checkHomeworkReview(homework, { ...review, suggestedScore: 10 }))["score-in-range"]!.ok,
    ).toBe(false);
    const essay = { ...review, strengths: ["x".repeat(301)] };
    expect(byId(checkHomeworkReview(homework, essay))["concise"]!.ok).toBe(false);
    const many = { ...review, weaknesses: Array.from({ length: 7 }, () => "w") };
    expect(byId(checkHomeworkReview(homework, many))["concise"]!.ok).toBe(false);
  });
});
