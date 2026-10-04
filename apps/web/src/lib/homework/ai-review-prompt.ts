import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { HomeworkAiReviewContent } from "@spiralclass/shared";

// Homework AI review — slice 5 (docs/features/homework.md). Pure
// prompt builder + structured-output contract, unit-testable without the
// Anthropic SDK's network call. Mirrors lib/lesson-notes/insights.ts's forced
// tool-call pattern: the model MUST return validated structure, never prose,
// and everything is teacher-language only — the output is never shown to the
// student verbatim (see HomeworkFeedback vs HomeworkAiReviewDraft).

export type AiReviewPromptInput = {
  assignmentTitle: string;
  assignmentInstructions: string | null;
  // Focused homework/exercise/answer excerpt from the source material, OR the
  // whole material body as a fallback (manually-authored assignment / no
  // recognized callout) — see extractHomeworkExcerptText. Null when the
  // assignment has no source material at all.
  materialExcerpt: string | null;
  attemptText: string | null;
  // Text-extractable attachment content (txt/pdf/docx already extracted to
  // plain text) and/or an audio transcript (slice 7), labelled by file name.
  attachmentTexts: { fileName: string; text: string }[];
  // Optional teacher steer for this specific review request.
  teacherInstructions: string | null;
  // The language the review is written in — the teacher's reading language, as
  // an English name ("French"); see localeEnglishName().
  outputLanguage: string;
};

// One English prompt that names the language to write in. There were an English
// and a Spanish copy chosen by a boolean, so a teacher reading French was sent
// an English review to edit and pass on to her student.
export function buildAiReviewPrompt(input: AiReviewPromptInput): {
  system: string;
  user: string;
} {
  const language = input.outputLanguage;
  const system = [
    "You are a language-teaching assistant helping a teacher review one student's homework submission for a one-to-one lesson.",
    "Analyse the student's answer against the assignment and (if provided) the source material's homework/exercise questions and answer key.",
    `Write every string in ${language}. When you quote the student, quote their words as they wrote them.`,
    "Hard rules you must follow:",
    "- Base every correction/strength/weakness on the student's actual submitted text or attachments. Never invent content the student didn't write.",
    "- Corrections should name the specific error and the fix, quoting the student's words where useful.",
    "- Keep strengths and weaknesses short and concrete — a few bullet points each, not paragraphs.",
    `- suggestedFeedback is a short, encouraging paragraph the teacher can edit and send to the student as-is; write it in ${language}, addressed to the student.`,
    "- suggestedScore (0-10, or omit if you cannot fairly judge) is only a starting point for the teacher, never a final grade.",
    "- If the assignment includes an answer key, use it to judge correctness; if not, judge on effort, accuracy, and completeness given the instructions.",
    "- Only emit grammarNotes when the material/assignment is clearly language-focused (grammar/vocabulary practice); otherwise omit it.",
    "Return your review only through the emit_homework_review tool.",
  ].join("\n");

  const sections: string[] = [];
  sections.push(`Assignment: ${input.assignmentTitle}`);
  if (input.assignmentInstructions) {
    sections.push(`Instructions:\n${input.assignmentInstructions}`);
  }
  if (input.materialExcerpt) {
    sections.push(`Source material (questions/answer key):\n${input.materialExcerpt}`);
  }
  sections.push(`Student's submitted text:\n${input.attemptText?.trim() || "(no text answer)"}`);
  for (const att of input.attachmentTexts) {
    sections.push(`Attachment "${att.fileName}":\n${att.text}`);
  }
  if (input.teacherInstructions) {
    sections.push(`Teacher's steer for this review:\n${input.teacherInstructions}`);
  }
  sections.push(`Review the submission and emit your findings, written in ${language}.`);

  return { system, user: sections.join("\n\n") };
}

export const AI_REVIEW_TOOL: Anthropic.Tool = {
  name: "emit_homework_review",
  description:
    "Emit a structured review of the student's homework submission. Use only evidence from the submission and assignment/material.",
  input_schema: {
    type: "object",
    properties: {
      corrections: { type: "array", items: { type: "string" } },
      strengths: { type: "array", items: { type: "string" } },
      weaknesses: { type: "array", items: { type: "string" } },
      grammarNotes: { type: "array", items: { type: "string" } },
      suggestedFeedback: { type: "string" },
      suggestedScore: { type: "integer", minimum: 0, maximum: 10 },
    },
    required: ["corrections", "strengths", "weaknesses", "suggestedFeedback"],
  },
};

const aiReviewToolInputSchema = z.object({
  corrections: z.array(z.string().trim().min(1)).default([]),
  strengths: z.array(z.string().trim().min(1)).default([]),
  weaknesses: z.array(z.string().trim().min(1)).default([]),
  grammarNotes: z.array(z.string().trim().min(1)).nullish(),
  suggestedFeedback: z.string().trim().min(1),
  suggestedScore: z.number().int().min(0).max(10).nullish(),
});

// Validate the model's tool input into a clean HomeworkAiReviewContent. Returns
// null on a malformed/empty response rather than throwing — the caller decides
// how to surface "the AI couldn't produce a usable review".
export function parseAiReviewToolInput(raw: unknown): HomeworkAiReviewContent | null {
  const parsed = aiReviewToolInputSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    corrections: parsed.data.corrections,
    strengths: parsed.data.strengths,
    weaknesses: parsed.data.weaknesses,
    grammarNotes:
      parsed.data.grammarNotes && parsed.data.grammarNotes.length > 0
        ? parsed.data.grammarNotes
        : null,
    suggestedFeedback: parsed.data.suggestedFeedback,
    suggestedScore: parsed.data.suggestedScore ?? null,
  };
}
