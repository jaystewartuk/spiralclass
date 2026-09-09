import { describe, expect, it } from "vitest";
import {
  SKILLS,
  isCanonicalSkill,
  normaliseSkill,
  skillLabel,
  suggestSkill,
} from "@/lib/lesson-notes/skills";
import { createT } from "@/lib/i18n-translate";

// The skill taxonomy is the stable grouping key the longitudinal profile rolls
// up by, so the match/normalise logic is pure and tested directly.

describe("suggestSkill", () => {
  it("matches a taxonomy alias within the insight's category", () => {
    expect(suggestSkill("grammar", "Confuses ser and estar with emotions")).toBe("ser_vs_estar");
    expect(suggestSkill("grammar", "Trouble with the subjuntivo")).toBe("subjunctive");
    expect(suggestSkill("grammar", "preterite vs imperfect mixups")).toBe("preterite_vs_imperfect");
  });

  it("only matches skills belonging to the given category", () => {
    // "vocal" → vowels is a pronunciation skill; under grammar it must NOT match it.
    const asGrammar = suggestSkill("grammar", "vocal sounds");
    expect(asGrammar).not.toBe("vowels");
    expect(suggestSkill("pronunciation", "weak vowel sounds")).toBe("vowels");
  });

  it("falls back to a normalised slug when nothing matches", () => {
    expect(suggestSkill("comprehension", "Lost the thread of a long story")).toBe(
      "lost_the_thread_of",
    );
  });
});

describe("normaliseSkill", () => {
  it("lowercases, strips accents/punctuation, joins words, bounds length", () => {
    expect(normaliseSkill("Pretérito, ¡otra vez!")).toBe("preterito_otra_vez");
    expect(normaliseSkill("one two three four five six")).toBe("one_two_three_four");
    expect(normaliseSkill("   ")).toBe("general");
  });
});

describe("isCanonicalSkill", () => {
  it("recognises taxonomy keys vs free-form fallbacks", () => {
    expect(isCanonicalSkill("grammar", "ser_vs_estar")).toBe(true);
    expect(isCanonicalSkill("grammar", "some_freeform_thing")).toBe(false);
    expect(isCanonicalSkill("pronunciation", "ser_vs_estar")).toBe(false);
  });
});

describe("skillLabel", () => {
  // The regression: both render sites printed the raw snake_case key, so a
  // teacher reading the dashboard in Spanish saw "ser_vs_estar" and
  // "filler_words" in the middle of otherwise-translated copy.
  it("translates a taxonomy key into the reader's language", () => {
    expect(skillLabel(createT("en"), "ser_vs_estar")).toBe("Ser vs. estar");
    expect(skillLabel(createT("es-MX"), "filler_words")).toBe("Muletillas");
    expect(skillLabel(createT("fr"), "filler_words")).toBe("Mots de remplissage");
  });

  it("never renders a raw key or a missing-key placeholder for the whole taxonomy", () => {
    for (const locale of ["en", "es-MX", "fr"] as const) {
      const t = createT(locale);
      for (const skill of Object.values(SKILLS).flat()) {
        const label = skillLabel(t, skill);
        expect(label).not.toBe(skill);
        expect(label).not.toContain("insights.skill.");
        expect(label.trim()).not.toBe("");
      }
    }
  });

  it("de-slugs a free-form skill invented by normaliseSkill", () => {
    // Those are per-lesson strings, not taxonomy — they have no catalog key and
    // never will, so the fallback must stay readable rather than blow up.
    expect(skillLabel(createT("es-MX"), "lost_the_thread_of")).toBe("lost the thread of");
  });
});
