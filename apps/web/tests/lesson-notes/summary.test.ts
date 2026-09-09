import { describe, expect, it } from "vitest";
import { buildSummaryPrompt, SUMMARY_MODEL, type SummaryInput } from "@/lib/lesson-notes/summary";

// The summary prompt is built purely (no network) so it can be asserted here.
// What matters: the model default, that the student's name + both note columns
// reach the prompt, that "done" cues are marked, and that the language switches.

const base: SummaryInput = {
  studentName: "Marco",
  when: "12 jun 2026, 10:00",
  teacherCues: [
    { body: "review past tense", done: true },
    { body: "ask about his trip", done: false },
  ],
  studentNotes: [{ body: "homework: pages 4-6" }],
  en: false,
};

describe("SUMMARY_MODEL", () => {
  // D-87: deliberately Haiku, not the latest/most-capable model — cost.
  it("is the Haiku model chosen in D-87", () => {
    expect(SUMMARY_MODEL).toBe("claude-haiku-4-5");
  });
});

describe("buildSummaryPrompt", () => {
  it("includes the student, the date, and both note columns", () => {
    const { system, user } = buildSummaryPrompt(base);
    expect(system).toContain("español");
    expect(user).toContain("Marco");
    expect(user).toContain("12 jun 2026, 10:00");
    expect(user).toContain("review past tense");
    expect(user).toContain("ask about his trip");
    expect(user).toContain("homework: pages 4-6");
  });

  it("marks checked-off cues and leaves un-done ones unmarked (es)", () => {
    const { user } = buildSummaryPrompt(base);
    expect(user).toContain("review past tense (visto)");
    expect(user).not.toContain("ask about his trip (visto)");
  });

  it("marks checked-off cues in English", () => {
    const { system, user } = buildSummaryPrompt({ ...base, en: true });
    expect(system).toContain("English");
    expect(user).toContain("review past tense (covered)");
  });

  it("shows a placeholder when a column is empty", () => {
    const { user } = buildSummaryPrompt({
      ...base,
      teacherCues: [],
      studentNotes: [],
      en: true,
    });
    // both columns render "(none)" rather than dropping the section
    expect(user.match(/\(none\)/g)).toHaveLength(2);
  });

  it("never instructs the model to invent detail — it must use only the notes", () => {
    expect(buildSummaryPrompt(base).system).toContain("nunca inventes");
    expect(buildSummaryPrompt({ ...base, en: true }).system).toContain("never invent");
  });
});
