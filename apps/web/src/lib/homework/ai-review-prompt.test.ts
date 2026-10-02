import { describe, expect, it } from "vitest";
import { buildAiReviewPrompt, type AiReviewPromptInput } from "./ai-review-prompt";

const BASE: AiReviewPromptInput = {
  assignmentTitle: "Essay",
  assignmentInstructions: "Write 5 sentences.",
  materialExcerpt: "1. Yo ___ (ser) feliz. Answer: soy",
  attemptText: "Yo es feliz.",
  attachmentTexts: [{ fileName: "notes.txt", text: "extra answer" }],
  teacherInstructions: "focus on tenses",
  outputLanguage: "English",
};

describe("buildAiReviewPrompt", () => {
  it("puts every part of the submission in front of the model", () => {
    const { user } = buildAiReviewPrompt(BASE);
    expect(user).toContain("Assignment: Essay");
    expect(user).toContain("Write 5 sentences.");
    expect(user).toContain("Answer: soy");
    expect(user).toContain("Yo es feliz.");
    expect(user).toContain('Attachment "notes.txt":\nextra answer');
    expect(user).toContain("focus on tenses");
  });

  it("says when there is no written answer", () => {
    const { user } = buildAiReviewPrompt({ ...BASE, attemptText: "  " });
    expect(user).toContain("(no text answer)");
  });

  it("carries the hard rules and the tool name", () => {
    const { system } = buildAiReviewPrompt(BASE);
    expect(system).toMatch(/Never invent content the student didn't write/);
    expect(system).toContain("emit_homework_review");
  });

  // There were an English and a Spanish prompt chosen by a boolean, so a teacher
  // reading French was handed an English review — including the feedback she
  // edits and sends on. One prompt names the language now.
  it.each(["Spanish", "French", "English"])("asks for the review in %s", (outputLanguage) => {
    const { system, user } = buildAiReviewPrompt({ ...BASE, outputLanguage });
    expect(system).toContain(`Write every string in ${outputLanguage}.`);
    expect(system).toContain(`write it in ${outputLanguage}, addressed to the student`);
    expect(user).toContain(`emit your findings, written in ${outputLanguage}.`);
  });

  it("is the same prompt in every language apart from the language", () => {
    const fr = buildAiReviewPrompt({ ...BASE, outputLanguage: "French" });
    const de = buildAiReviewPrompt({ ...BASE, outputLanguage: "German" });
    expect(fr.system.replaceAll("French", "X")).toBe(de.system.replaceAll("German", "X"));
    expect(fr.user.replaceAll("French", "X")).toBe(de.user.replaceAll("German", "X"));
  });
});
