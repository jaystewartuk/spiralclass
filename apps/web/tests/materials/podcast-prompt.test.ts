import { describe, expect, it } from "vitest";
import { buildPodcastScriptPrompt } from "@/lib/materials/podcast-prompt";

// Podcast SCRIPT prompt builder — rewrites a material's Markdown body as a
// spoken single-narrator monologue for TTS. Pure, so no SDK/DB needed.

const base = {
  body: "# Present simple\n\n- I work\n- You work\n\n| a | b |\n|---|---|",
  locale: "en" as const,
  targetDurationMin: 4,
};

describe("buildPodcastScriptPrompt", () => {
  it("forbids Markdown/formatting so the TTS voice reads clean prose", () => {
    const { system } = buildPodcastScriptPrompt(base);
    expect(system).toMatch(/read aloud/i);
    expect(system).toMatch(/Markdown/i);
    expect(system).toMatch(/spoken/i);
    // Explicitly names the things a TTS engine would mangle.
    expect(system).toMatch(/headings|bullet|lists|tables/i);
  });

  it("includes the material body to narrate in the user prompt", () => {
    const { user } = buildPodcastScriptPrompt(base);
    expect(user).toContain("Present simple");
  });

  it("defaults narration language to Spanish for es-MX and English for en", () => {
    expect(buildPodcastScriptPrompt({ ...base, locale: "es-MX" }).system).toMatch(/Spanish/);
    expect(buildPodcastScriptPrompt({ ...base, locale: "en" }).system).toMatch(/English/);
  });

  it("splits output vs target language for a language teacher", () => {
    // Narrate in Spanish, but speak the French example sentences in French.
    const { system } = buildPodcastScriptPrompt({
      ...base,
      locale: "es-MX",
      language: "Spanish",
      targetLanguage: "French",
    });
    expect(system).toMatch(/French/);
    expect(system).toMatch(/Spanish/);
    expect(system).toMatch(/spoken in French/i);
  });

  it("sizes the word budget from the target duration (~150 wpm)", () => {
    const short = buildPodcastScriptPrompt({ ...base, targetDurationMin: 2 }).system;
    const long = buildPodcastScriptPrompt({ ...base, targetDurationMin: 6 }).system;
    expect(short).toMatch(/about 300 words/);
    expect(long).toMatch(/about 900 words/);
  });

  it("passes the level through to set the register", () => {
    const { system } = buildPodcastScriptPrompt({ ...base, levelLabel: "B1" });
    expect(system).toMatch(/"B1"/);
  });

  it("lists focus labels when present", () => {
    const { user } = buildPodcastScriptPrompt({ ...base, focusLabels: ["verbs", "daily routine"] });
    expect(user).toMatch(/verbs; daily routine/);
  });

  it("always asserts the one-to-one constraint, even when unset (D-88)", () => {
    const { system } = buildPodcastScriptPrompt(base);
    expect(system).toMatch(/ONE-TO-ONE lesson/i);
    expect(system).toMatch(/NEVER include pair work, group work, team activities/i);
  });
});
