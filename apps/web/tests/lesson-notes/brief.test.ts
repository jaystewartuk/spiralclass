import { describe, expect, it } from "vitest";
import {
  buildBriefPrompt,
  parseBriefToolInput,
  MAX_BRIEF_FOCUS,
  type BriefInput,
} from "@/lib/lesson-notes/brief";
import type { StudentProfile } from "@/lib/lesson-notes/profile";

const ISO = "2026-06-15T15:00:00.000Z";

const PROFILE: StudentProfile = {
  byCategory: {
    grammar: {
      ser_vs_estar: {
        recurrenceCount: 3,
        firstSeenAt: ISO,
        lastSeenAt: ISO,
        trend: "focus",
        lastEvidence: "yo es feliz",
      },
      subjunctive: {
        recurrenceCount: 1,
        firstSeenAt: ISO,
        lastSeenAt: ISO,
        trend: "improving",
        lastEvidence: null,
      },
    },
    fluency: {
      hesitation: {
        recurrenceCount: 1,
        firstSeenAt: ISO,
        lastSeenAt: ISO,
        trend: "new",
        lastEvidence: null,
      },
    },
  },
  vocabulary: [{ term: "la sobremesa", lastSeenAt: ISO }],
  speakingBalance: null,
};

const BASE: BriefInput = {
  studentName: "Mira",
  language: "es",
  profile: PROFILE,
  outputLanguage: "English",
};

describe("buildBriefPrompt", () => {
  it("lists actionable focus areas with why-signal, leading with focus", () => {
    const { user } = buildBriefPrompt(BASE);
    expect(user).toContain("ser_vs_estar (grammar, focus, seen 3×)");
    expect(user).toContain('"yo es feliz"');
    expect(user).toContain("hesitation (fluency, new");
    // focus appears before the 'new' item in the actionable list.
    expect(user.indexOf("ser_vs_estar")).toBeLessThan(user.indexOf("hesitation"));
  });

  it("keeps 'improving' skills out of the actionable cues and only mentions them as encouragement", () => {
    const { user } = buildBriefPrompt(BASE);
    // subjunctive (improving) is in the improving line, NOT the focus list.
    const focusBlock = user.slice(0, user.indexOf("Improving"));
    expect(focusBlock).not.toContain("subjunctive");
    expect(user).toMatch(/Improving[^]*subjunctive/);
  });

  it("carries the hard rules and the tool name", () => {
    const { system } = buildBriefPrompt(BASE);
    expect(system).toMatch(/Use ONLY the profile provided/);
    expect(system).toMatch(/Never invent a weakness/i);
    expect(system).toMatch(/NEVER nag about 'improving'/);
    expect(system).toMatch(/At most three suggested cues/);
    expect(system).toContain("emit_brief");
  });

  // There were an English and a Spanish prompt chosen by a boolean, so a teacher
  // reading French was briefed in Spanish. One prompt names the language now.
  it.each(["Spanish", "French", "English"])("asks for the brief in %s", (outputLanguage) => {
    const { system, user } = buildBriefPrompt({ ...BASE, outputLanguage });
    expect(system).toContain(`Write every string in ${outputLanguage}.`);
    expect(user).toContain(`Write the prep brief in ${outputLanguage}.`);
    // the subject being learned is a separate thing from the reader's language
    expect(user).toContain("Target language: es");
  });

  it("is the same prompt in every language apart from the language", () => {
    const fr = buildBriefPrompt({ ...BASE, outputLanguage: "French" });
    const es = buildBriefPrompt({ ...BASE, outputLanguage: "Spanish" });
    expect(fr.system.replaceAll("French", "X")).toBe(es.system.replaceAll("Spanish", "X"));
    expect(fr.user.replaceAll("French", "X")).toBe(es.user.replaceAll("Spanish", "X"));
  });

  it("handles an empty profile", () => {
    const { user } = buildBriefPrompt({
      ...BASE,
      profile: { byCategory: {}, vocabulary: [], speakingBalance: null },
    });
    expect(user).toContain("(none)");
  });
});

describe("parseBriefToolInput", () => {
  it("maps a valid tool input", () => {
    const brief = parseBriefToolInput({
      summary: "Focus on ser/estar.",
      focus: [
        {
          skill: "ser_vs_estar",
          category: "grammar",
          why: "recurs",
          suggestedCue: "Drill ser vs estar with a photo prompt",
        },
      ],
      vocabulary: ["la sobremesa", "el madrugón"],
    });
    expect(brief.summary).toBe("Focus on ser/estar.");
    expect(brief.focus).toEqual([
      {
        skill: "ser_vs_estar",
        category: "grammar",
        why: "recurs",
        suggestedCue: "Drill ser vs estar with a photo prompt",
      },
    ]);
    expect(brief.vocabulary).toEqual(["la sobremesa", "el madrugón"]);
  });

  it("drops malformed focus items and caps the cue count", () => {
    const brief = parseBriefToolInput({
      summary: "s",
      focus: [
        { skill: "a", category: "grammar", suggestedCue: "cue a" },
        { skill: "b", category: "not-a-cat", suggestedCue: "bad enum" },
        { skill: "c", category: "fluency" }, // missing suggestedCue
        { skill: "d", category: "vocabulary", suggestedCue: "cue d" },
        { skill: "e", category: "comprehension", suggestedCue: "cue e" },
        { skill: "f", category: "pronunciation", suggestedCue: "cue f" },
      ],
    });
    expect(brief.focus.map((f) => f.skill)).toEqual(["a", "d", "e"]); // valid ones, capped at MAX
    expect(brief.focus).toHaveLength(MAX_BRIEF_FOCUS);
  });

  it("degrades to an empty brief on a malformed payload", () => {
    expect(parseBriefToolInput({})).toEqual({ summary: "", focus: [], vocabulary: [] });
    expect(parseBriefToolInput(null)).toEqual({ summary: "", focus: [], vocabulary: [] });
  });
});
