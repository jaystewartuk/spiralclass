import Anthropic from "@anthropic-ai/sdk";
import { anthropicApiKey } from "@/lib/env";

// AI post-class lesson summary (live-notes-panel.md "step 2", D-15). Turns a
// class's live notes — the teacher's private cues (with what got checked off)
// and the student-facing instructions — into a short recap the teacher can skim
// later. Teacher-only; never shown to the student. Pro-gated at the action.

// Haiku (D-87 — cost). Summarization is a single, short request (max_tokens
// 1024), so no extended thinking is needed. Haiku is safe HERE specifically
// because this call passes NO `output_config.effort` — `effort` is rejected
// with a 400 on pre-4.6 models including Haiku 4.5, which is why the
// effort-passing class-content compose path (anthropicModel(), lib/ai/
// anthropic.ts) stayed on Sonnet 5 instead. If you ever add `effort` here, you
// must move this constant to an effort-capable model in the same change.
// Hardcoded: ANTHROPIC_MODEL does NOT override this.
export const SUMMARY_MODEL = "claude-haiku-4-5";

export type SummaryInput = {
  studentName: string;
  when: string; // already-formatted class date/time
  teacherCues: { body: string; done: boolean }[];
  studentNotes: { body: string }[];
  en: boolean;
};

// Raised when the platform has no Anthropic key configured, so the action can
// surface a friendly "not available" message rather than a 500.
export class SummaryUnavailableError extends Error {}

// The prompt is built here (pure) so it can be unit-tested without a network
// call. Both halves are localized to the teacher's language.
export function buildSummaryPrompt(input: SummaryInput): { system: string; user: string } {
  const { en } = input;

  const system = en
    ? "You are an assistant to a private teacher. You write a short, plain post-class recap from the teacher's own in-class notes, for her records. Be concise and concrete. Use only the notes provided — never invent details. Write in English. Use three short labelled sections: Covered, Follow up, Homework. If a section has nothing, omit it. No preamble, no closing remarks."
    : "Eres asistente de una profe particular. Escribes un resumen breve y claro de la clase a partir de las notas que la profe tomó durante la clase, para su registro. Sé concisa y concreta. Usa solo las notas proporcionadas; nunca inventes detalles. Escribe en español. Usa tres secciones cortas con título: Lo que se vio, Seguimiento, Tarea. Si una sección no aplica, omítela. Sin preámbulo ni despedida.";

  const cueLines = input.teacherCues.length
    ? input.teacherCues
        .map((c) => `- ${c.body}${c.done ? (en ? " (covered)" : " (visto)") : ""}`)
        .join("\n")
    : en
      ? "(none)"
      : "(ninguna)";
  const noteLines = input.studentNotes.length
    ? input.studentNotes.map((n) => `- ${n.body}`).join("\n")
    : en
      ? "(none)"
      : "(ninguna)";

  const user = en
    ? `Class with ${input.studentName} on ${input.when}.\n\nMy private cues (what I planned to cover; "(covered)" means I checked it off):\n${cueLines}\n\nInstructions I gave the student during class:\n${noteLines}\n\nWrite the recap.`
    : `Clase con ${input.studentName} el ${input.when}.\n\nMis apuntes privados (lo que planeé cubrir; "(visto)" significa que lo marqué como hecho):\n${cueLines}\n\nIndicaciones que le di al alumno durante la clase:\n${noteLines}\n\nEscribe el resumen.`;

  return { system, user };
}

// Generate the summary text via Claude. Throws SummaryUnavailableError when no
// key is configured (dev/test), and lets SDK errors propagate to the caller.
export async function generateSummaryText(
  input: SummaryInput,
): Promise<{ body: string; model: string }> {
  const apiKey = anthropicApiKey();
  if (!apiKey) throw new SummaryUnavailableError("ANTHROPIC_API_KEY not configured");

  const client = new Anthropic({ apiKey });
  const { system, user } = buildSummaryPrompt(input);

  const response = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: user }],
  });

  const body = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return { body, model: response.model };
}
