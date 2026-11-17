import Anthropic from "@anthropic-ai/sdk";
import { anthropicApiKey, anthropicSmallModel } from "@/lib/env";

// AI post-class lesson summary (docs/features/classes-lesson-content.md). Turns a
// class's live notes — the teacher's private cues (with what got checked off)
// and the student-facing instructions — into a short recap the teacher can skim
// later. Teacher-only; never shown to the student. Pro-gated at the action.

// Model: anthropicSmallModel() (lib/env.ts) — Haiku 4.5 by default (D-87 —
// cost), moved by ANTHROPIC_SMALL_MODEL together with the other short calls.
// Summarization is a single, short request (max_tokens 1024), so no extended
// thinking is needed. It passes NO `output_config.effort`, which 400s on
// pre-4.6 models; adding `effort` here means adding it to the small tier's
// requirements in lib/ai/models.ts in the same change.

export type SummaryInput = {
  studentName: string;
  when: string; // already-formatted class date/time
  teacherCues: { body: string; done: boolean }[];
  studentNotes: { body: string }[];
  // The language the recap is written in — the teacher's reading language, as
  // an English name ("French"); see localeEnglishName().
  language: string;
};

// Raised when the platform has no Anthropic key configured, so the action can
// surface a friendly "not available" message rather than a 500.
export class SummaryUnavailableError extends Error {}

// The prompt is built here (pure) so it can be unit-tested without a network
// call.
//
// The instructions are in English, and the language of the recap is a rule in
// them. There used to be an English prompt and a Spanish one, picked by a
// boolean: every teacher who read neither got an English recap, and keeping two
// prompts saying the same thing in step was the kind of work that drifts. The
// model takes English instructions most reliably and writes the recap — section
// titles included — in whatever language it is told.
export function buildSummaryPrompt(input: SummaryInput): { system: string; user: string } {
  const system = [
    "You are an assistant to a private teacher. You write a short, plain post-class recap from the teacher's own in-class notes, for her records. Be concise and concrete. Use only the notes provided — never invent details.",
    `Write the whole recap in ${input.language}, including the section titles.`,
    "Use three short titled sections: what was covered, what to follow up, and homework. If a section has nothing, omit it. No preamble, no closing remarks.",
    "The notes are quoted as the teacher wrote them and may be in another language; keep their content, but write the recap itself in the language above.",
  ].join(" ");

  const cueLines = input.teacherCues.length
    ? input.teacherCues.map((c) => `- ${c.body}${c.done ? " (covered)" : ""}`).join("\n")
    : "(none)";
  const noteLines = input.studentNotes.length
    ? input.studentNotes.map((n) => `- ${n.body}`).join("\n")
    : "(none)";

  const user = `Class with ${input.studentName} on ${input.when}.\n\nMy private cues (what I planned to cover; "(covered)" means I checked it off):\n${cueLines}\n\nInstructions I gave the student during class:\n${noteLines}\n\nWrite the recap in ${input.language}.`;

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
    model: anthropicSmallModel(),
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
