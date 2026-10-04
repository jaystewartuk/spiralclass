import { describe, expect, it } from "vitest";
import { buildSummaryPrompt, SUMMARY_MODEL, type SummaryInput } from "@/lib/lesson-notes/summary";

// The summary prompt is built purely (no network) so it can be asserted here.
// What matters: the model default, that the student's name + both note columns
// reach the prompt, that "done" cues are marked, and that the recap is asked
// for in the teacher's own language.

const base: SummaryInput = {
  studentName: "Marco",
  when: "12 jun 2026, 10:00",
  teacherCues: [
    { body: "review past tense", done: true },
    { body: "ask about his trip", done: false },
  ],
  studentNotes: [{ body: "homework: pages 4-6" }],
  language: "Spanish",
};

describe("SUMMARY_MODEL", () => {
  // D-87: deliberately Haiku, not the latest/most-capable model — cost.
  it("is the Haiku model chosen in D-87", () => {
    expect(SUMMARY_MODEL).toBe("claude-haiku-4-5");
  });
});

describe("buildSummaryPrompt", () => {
  it("includes the student, the date, and both note columns", () => {
    const { user } = buildSummaryPrompt(base);
    expect(user).toContain("Marco");
    expect(user).toContain("12 jun 2026, 10:00");
    expect(user).toContain("review past tense");
    expect(user).toContain("ask about his trip");
    expect(user).toContain("homework: pages 4-6");
  });

  it("marks checked-off cues and leaves un-done ones unmarked", () => {
    const { user } = buildSummaryPrompt(base);
    expect(user).toContain("review past tense (covered)");
    expect(user).not.toContain("ask about his trip (covered)");
  });

  // There were two prompts, English and Spanish, chosen by a boolean, so a
  // teacher reading French got an English recap. One prompt now names the
  // language to write in, so any language the app speaks is asked for by name.
  it.each(["Spanish", "French", "English", "German"])(
    "asks for the whole recap, titles included, in %s",
    (language) => {
      const { system, user } = buildSummaryPrompt({ ...base, language });
      expect(system).toContain(
        `Write the whole recap in ${language}, including the section titles.`,
      );
      expect(user).toContain(`Write the recap in ${language}.`);
    },
  );

  it("is the same prompt whatever the language, apart from the language", () => {
    const fr = buildSummaryPrompt({ ...base, language: "French" });
    const es = buildSummaryPrompt(base);
    expect(fr.system.replaceAll("French", "X")).toBe(es.system.replaceAll("Spanish", "X"));
    expect(fr.user.replaceAll("French", "X")).toBe(es.user.replaceAll("Spanish", "X"));
  });

  it("shows a placeholder when a column is empty", () => {
    const { user } = buildSummaryPrompt({ ...base, teacherCues: [], studentNotes: [] });
    // both columns render "(none)" rather than dropping the section
    expect(user.match(/\(none\)/g)).toHaveLength(2);
  });

  it("never instructs the model to invent detail — it must use only the notes", () => {
    expect(buildSummaryPrompt(base).system).toContain("never invent");
  });
});
