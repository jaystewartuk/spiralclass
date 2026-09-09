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
  en: boolean;
};

export function buildAiReviewPrompt(input: AiReviewPromptInput): {
  system: string;
  user: string;
} {
  const { en } = input;

  const system = (
    en
      ? [
          "You are a language-teaching assistant helping a teacher review one student's homework submission for a one-to-one lesson.",
          "Analyse the student's answer against the assignment and (if provided) the source material's homework/exercise questions and answer key.",
          "Hard rules you must follow:",
          "- Base every correction/strength/weakness on the student's actual submitted text or attachments. Never invent content the student didn't write.",
          "- Corrections should name the specific error and the fix, quoting the student's words where useful.",
          "- Keep strengths and weaknesses short and concrete — a few bullet points each, not paragraphs.",
          "- suggestedFeedback is a short, encouraging paragraph the teacher can edit and send to the student as-is; write it in the teacher's language, addressed to the student.",
          "- suggestedScore (0-10, or omit if you cannot fairly judge) is only a starting point for the teacher, never a final grade.",
          "- If the assignment includes an answer key, use it to judge correctness; if not, judge on effort, accuracy, and completeness given the instructions.",
          "- Only emit grammarNotes when the material/assignment is clearly language-focused (grammar/vocabulary practice); otherwise omit it.",
          "Return your review only through the emit_homework_review tool.",
        ]
      : [
          "Eres un asistente de enseñanza de idiomas que ayuda a una profe a revisar la tarea de un alumno de una clase individual.",
          "Analiza la respuesta del alumno frente a la tarea asignada y (si se proporciona) las preguntas del material de origen y su clave de respuestas.",
          "Reglas estrictas que debes cumplir:",
          "- Basa cada corrección/fortaleza/debilidad en el texto o los archivos que el alumno realmente envió. Nunca inventes contenido que el alumno no escribió.",
          "- Las correcciones deben nombrar el error específico y la solución, citando las palabras del alumno cuando sea útil.",
          "- Mantén las fortalezas y debilidades breves y concretas — unos pocos puntos cada una, no párrafos.",
          "- suggestedFeedback es un párrafo breve y alentador que la profe puede editar y enviar al alumno tal cual; escríbelo en el idioma de la profe, dirigido al alumno.",
          "- suggestedScore (0-10, u omítelo si no puedes juzgarlo con justicia) es solo un punto de partida para la profe, nunca una calificación final.",
          "- Si la tarea incluye una clave de respuestas, úsala para juzgar la corrección; si no, evalúa el esfuerzo, la precisión y qué tan completa está la respuesta según las instrucciones.",
          "- Solo incluye grammarNotes cuando el material/tarea esté claramente enfocado en el idioma (práctica de gramática/vocabulario); si no, omítelo.",
          "Devuelve tu revisión únicamente mediante la herramienta emit_homework_review.",
        ]
  ).join("\n");

  const sections: string[] = [];
  sections.push(en ? `Assignment: ${input.assignmentTitle}` : `Tarea: ${input.assignmentTitle}`);
  if (input.assignmentInstructions) {
    sections.push((en ? "Instructions:\n" : "Instrucciones:\n") + input.assignmentInstructions);
  }
  if (input.materialExcerpt) {
    sections.push(
      (en
        ? "Source material (questions/answer key):\n"
        : "Material de origen (preguntas/clave de respuestas):\n") + input.materialExcerpt,
    );
  }
  sections.push(
    (en ? "Student's submitted text:\n" : "Texto enviado por el alumno:\n") +
      (input.attemptText?.trim() || (en ? "(no text answer)" : "(sin respuesta escrita)")),
  );
  for (const att of input.attachmentTexts) {
    sections.push(`${en ? "Attachment" : "Archivo adjunto"} "${att.fileName}":\n${att.text}`);
  }
  if (input.teacherInstructions) {
    sections.push(
      (en ? "Teacher's steer for this review:\n" : "Indicación de la profe para esta revisión:\n") +
        input.teacherInstructions,
    );
  }
  sections.push(
    en
      ? "Review the submission and emit your findings."
      : "Revisa la entrega y emite tus hallazgos.",
  );

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
