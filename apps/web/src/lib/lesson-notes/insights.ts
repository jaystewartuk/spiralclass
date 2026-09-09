import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { InsightCategory } from "@prisma/client";
import { languageName } from "@spiralclass/shared";
import { anthropicApiKey } from "@/lib/env";

// AI lesson insights — Phase C (the Phase C design,
// D-19). The structured evolution of the free-text lesson_summaries: instead of
// prose, it emits typed, categorised, evidence-anchored focus areas ("work on
// your subjunctive") from a transcript + the teacher's live-notes. Teacher-only;
// Pro-gated upstream (only Pro lessons get captured/transcribed). Mirrors
// summary.ts — pure prompt builder + a degrade-gracefully Claude call — but uses
// a FORCED TOOL CALL so the model returns validated structure, not parseable prose.

// Same model as the summary; a single short analysis request (max_tokens 2048).
// Haiku (D-87 — cost). Safe here because this call passes NO
// `output_config.effort` — `effort` 400s on pre-4.6 models including Haiku 4.5,
// which is why the effort-passing class-content compose path stayed on Sonnet
// 5. Adding `effort` here requires moving this constant to an effort-capable
// model in the same change. Hardcoded: ANTHROPIC_MODEL does NOT override this.
export const INSIGHTS_MODEL = "claude-haiku-4-5";

// The five focus-area categories (matches the Prisma InsightCategory enum).
export const INSIGHT_CATEGORIES = [
  "pronunciation",
  "grammar",
  "vocabulary",
  "fluency",
  "comprehension",
] as const;

// Conservative by design (open question #6): a wall of nitpicks makes the
// Phase-E validation step a chore and erodes trust. Capped per category.
export const MAX_INSIGHTS_PER_CATEGORY = 3;

export type InsightUtterance = {
  speaker: "student" | "teacher";
  text: string;
  atMs: number;
};

export type InsightsInput = {
  studentName: string;
  // The lesson's target language (BCP-47, Spanish-first "es") — context only.
  targetLanguage: string;
  // The merged transcript (both speakers), ordered by time.
  utterances: InsightUtterance[];
  // Teacher live-notes: private cues (intent, with what got checked off) and the
  // student-facing instructions. The teacher's own transcript utterances carry
  // corrections; these carry intent — together they're the "teacher signals".
  teacherCues: { body: string; done: boolean }[];
  studentNotes: { body: string }[];
  // Whether the summary/suggestion text is written in English. Derive it with
  // `writesEnglishInsights()` rather than by hand — see that function for why
  // the predicate is "is she Spanish-reading", not "is she English-reading".
  en: boolean;
  // Phase D: audio-grounded
  // pronunciation scores, present only when scoring ran. When present, the
  // pronunciation rule flips from "teacher-signal-only" to "use these scores as
  // the evidence", so pronunciation findings come from the recording, not spelling.
  pronunciation?: { weakWords: PronunciationWeakWord[] };
};

export type PronunciationWeakWord = {
  word: string;
  accuracy: number; // 0–100, lower = worse
  atMs: number;
  phonemes?: { phoneme: string; accuracy: number }[];
};

export type Insight = {
  category: InsightCategory;
  summary: string;
  evidence: string | null;
  suggestion: string | null;
  atMs: number | null;
};

// Raised when the platform has no Anthropic key configured, so the caller can
// skip/surface a friendly absence rather than 500 (mirrors SummaryUnavailableError).
export class InsightsUnavailableError extends Error {}

// ---------------------------------------------------------------------------
// Prompt (pure — unit-tested without a network call). Localized to the teacher's
// reading language. Evidence stays in the student's own words regardless.
/**
 * Whether findings for this reader should be written in English.
 *
 * The prompt below exists in exactly two languages, English and Spanish, and
 * that is a property of THIS FILE, not of the app — the catalog ships `fr` and
 * will ship more. So the question this answers is "is she a Spanish reader",
 * and everyone else falls back to English, which is `DEFAULT_LOCALE`.
 *
 * It was written the other way round until 2026-08-31 (`locale === "en"`), which
 * looks equivalent and is not: with two locales the two predicates agree, and
 * with three they diverge in the worst direction. A French-reading teacher was
 * not getting the English fallback — `fr !== "en"` is false, so she dropped into
 * the SPANISH branch and got findings in a language she had not chosen and the
 * app was not showing her. Adding a locale to the catalog is what triggers it,
 * which is exactly when nobody is looking at this file.
 */
export function writesEnglishInsights(locale: string): boolean {
  return locale !== "es-MX";
}

// ---------------------------------------------------------------------------
export function buildInsightsPrompt(input: InsightsInput): { system: string; user: string } {
  const { en } = input;
  const weakWords = input.pronunciation?.weakWords ?? [];
  const hasPron = weakWords.length > 0;
  const targetLanguageName = languageName(input.targetLanguage);

  // The class is taught IN the target language, which is independent of `en`
  // (the teacher's own reading language for the summary/suggestion text —
  // D-72/D-73's four-language-fields lesson applies here too). Without this
  // rule the model has judged a student's TARGET-language grammar by some
  // other language's rules (e.g. flagging correct Spanish as wrong), because
  // the target language was passed as inert context rather than as the
  // standard to grade against.
  const languageRule = en
    ? `- The lesson is taught in ${targetLanguageName} (this is the language the student is being evaluated in — judge every finding against ITS grammar/vocabulary rules, never the reading language below). Write your summary/evidence/suggestion text in English, but keep the student's cited words in ${targetLanguageName} exactly as spoken.`
    : `- La clase se imparte en ${targetLanguageName} (es el idioma en el que se evalúa al alumno — juzga cada observación según SUS reglas de gramática/vocabulario, nunca según el idioma de lectura de abajo). Escribe el resumen/evidencia/sugerencia en español, pero conserva las palabras citadas del alumno tal como las dijo, en ${targetLanguageName}.`;

  // The pronunciation rule flips when audio scores are available (Phase D): from
  // "teacher-signal-only, never guess from spelling" to "use the scores below".
  const pronRule = en
    ? hasPron
      ? "- PRONUNCIATION: audio pronunciation scores are provided below. Base any pronunciation finding ONLY on those scored weak words and their phoneme scores (this is the recording, not spelling). Cite the weak word as evidence, name the target sound in the suggestion, and use that word's atMs."
      : "- PRONUNCIATION: the transcript is text and cannot hear sound. Only emit a pronunciation finding when the TEACHER'S notes or spoken corrections raise one. Never guess pronunciation from spelling."
    : hasPron
      ? "- PRONUNCIATION: abajo se incluyen puntajes de pronunciación del audio. Basa cualquier observación de pronunciación SOLO en esas palabras débiles puntuadas y sus puntajes de fonemas (es la grabación, no la ortografía). Cita la palabra débil como evidencia, nombra el sonido objetivo en la sugerencia y usa el atMs de esa palabra."
      : "- PRONUNCIATION: la transcripción es texto y no puede oír el sonido. Emite una observación de pronunciación solo cuando las notas o correcciones de la profe la señalen. Nunca adivines la pronunciación a partir de la ortografía.";

  const system = (
    en
      ? [
          "You are a language-teaching assistant analysing the transcript of a one-to-one lesson for a single student.",
          "Identify the student's key focus areas — the few things most worth working on next — across these categories only: pronunciation, grammar, vocabulary, fluency, comprehension.",
          "Hard rules you must follow:",
          "- Use ONLY the provided transcript and teacher notes. Never invent errors, never infer beyond the evidence. If the lesson shows little, return few or no findings.",
          "- Every finding must cite the student's exact words as evidence, and include the atMs timestamp of that utterance (copy it from the [Nms] tag on the line).",
          "- Give one concrete suggestion (the correct form, a drill, or a target) per finding.",
          "- Be conservative and high-signal. At most three findings per category; prefer fewer. A short, sharp list the teacher trusts beats an exhaustive one.",
          languageRule,
          pronRule,
          "Return your findings only through the emit_insights tool.",
        ]
      : [
          "Eres un asistente de enseñanza de idiomas que analiza la transcripción de una clase individual de un solo alumno.",
          "Identifica las áreas de enfoque clave del alumno —lo poco que más conviene trabajar a continuación— únicamente en estas categorías: pronunciation, grammar, vocabulary, fluency, comprehension.",
          "Reglas estrictas que debes cumplir:",
          "- Usa SOLO la transcripción y las notas de la profe. Nunca inventes errores ni infieras más allá de la evidencia. Si la clase muestra poco, devuelve pocas o ninguna observación.",
          "- Cada observación debe citar las palabras exactas del alumno como evidencia e incluir el atMs de esa intervención (cópialo de la etiqueta [Nms] de la línea).",
          "- Da una sugerencia concreta (la forma correcta, un ejercicio o un objetivo) por observación.",
          "- Sé conservador y de alta señal. Como máximo tres observaciones por categoría; mejor menos. Una lista corta y precisa en la que la profe confíe vale más que una exhaustiva.",
          languageRule,
          pronRule,
          "Devuelve tus observaciones únicamente mediante la herramienta emit_insights.",
        ]
  ).join("\n");

  const transcriptLines = input.utterances.length
    ? input.utterances.map((u) => `[${u.atMs}ms] ${u.speaker}: ${u.text}`).join("\n")
    : en
      ? "(empty transcript)"
      : "(transcripción vacía)";

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

  // Phase D: the audio-scored weak words, lowest accuracy first, with their
  // moment and any weak phonemes — the evidence for pronunciation findings.
  const pronLines = weakWords
    .map((w) => {
      const sounds = w.phonemes?.length
        ? `${en ? " — weak sounds: " : " — sonidos débiles: "}${w.phonemes.map((p) => p.phoneme).join(", ")}`
        : "";
      return `- "${w.word}" (${Math.round(w.accuracy)}/100) [${w.atMs}ms]${sounds}`;
    })
    .join("\n");
  const pronSection = hasPron
    ? en
      ? `\n\nPronunciation scores from the audio (lower = worse — use these for any pronunciation finding):\n${pronLines}`
      : `\n\nPuntajes de pronunciación del audio (menor = peor — úsalos para cualquier observación de pronunciación):\n${pronLines}`
    : "";

  const user = en
    ? `Student: ${input.studentName}. Target language (the class is taught in this — grade correctness against it): ${targetLanguageName}.\n\nTranscript (each line tagged with its moment in the lesson):\n${transcriptLines}\n\nMy private cues (what I planned to cover; "(covered)" = checked off):\n${cueLines}\n\nInstructions I gave the student during class:\n${noteLines}${pronSection}\n\nAnalyse the lesson and emit the focus areas.`
    : `Alumno: ${input.studentName}. Idioma meta (la clase se imparte en este idioma — evalúa la corrección según sus reglas): ${targetLanguageName}.\n\nTranscripción (cada línea con su momento en la clase):\n${transcriptLines}\n\nMis apuntes privados (lo que planeé cubrir; "(visto)" = marcado):\n${cueLines}\n\nIndicaciones que le di al alumno durante la clase:\n${noteLines}${pronSection}\n\nAnaliza la clase y emite las áreas de enfoque.`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// Structured output: a forced tool call. The model must return its findings as
// the tool input, which we validate server-side before trusting it.
// ---------------------------------------------------------------------------
export const INSIGHTS_TOOL: Anthropic.Tool = {
  name: "emit_insights",
  description:
    "Emit the student's focus areas for this lesson. Use only evidence from the transcript and teacher notes.",
  input_schema: {
    type: "object",
    properties: {
      insights: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: [...INSIGHT_CATEGORIES] },
            summary: { type: "string", description: "The finding, in the teacher's language." },
            evidence: {
              type: "string",
              description: "The student's exact words this is anchored to.",
            },
            suggestion: { type: "string", description: "Correct form / drill / target." },
            atMs: { type: "integer", description: "Timestamp (ms) of the cited utterance." },
          },
          required: ["category", "summary"],
        },
      },
    },
    required: ["insights"],
  },
};

const insightItemSchema = z.object({
  category: z.enum(INSIGHT_CATEGORIES),
  summary: z.string().trim().min(1),
  evidence: z.string().trim().min(1).nullish(),
  suggestion: z.string().trim().min(1).nullish(),
  atMs: z.number().int().nonnegative().nullish(),
});

// Validate the model's tool input into clean Insight rows. Validates each item
// independently so one malformed finding doesn't drop the rest, then caps per
// category.
export function parseInsightsToolInput(raw: unknown): Insight[] {
  const list = (raw as { insights?: unknown })?.insights;
  if (!Array.isArray(list)) return [];
  const insights: Insight[] = [];
  for (const item of list) {
    const parsed = insightItemSchema.safeParse(item);
    if (!parsed.success) continue;
    insights.push({
      category: parsed.data.category,
      summary: parsed.data.summary,
      evidence: parsed.data.evidence ?? null,
      suggestion: parsed.data.suggestion ?? null,
      atMs: parsed.data.atMs ?? null,
    });
  }
  return capPerCategory(insights);
}

// Defensive cap (the prompt also asks for it): at most N per category, keeping
// the model's order (it leads with what it judged most important).
export function capPerCategory(insights: Insight[], max = MAX_INSIGHTS_PER_CATEGORY): Insight[] {
  const counts = new Map<InsightCategory, number>();
  const kept: Insight[] = [];
  for (const insight of insights) {
    const n = counts.get(insight.category) ?? 0;
    if (n >= max) continue;
    counts.set(insight.category, n + 1);
    kept.push(insight);
  }
  return kept;
}

// Generate insights via Claude with a forced tool call. Throws
// InsightsUnavailableError when no key is configured; lets SDK errors propagate.
export async function generateInsights(input: InsightsInput): Promise<Insight[]> {
  const apiKey = anthropicApiKey();
  if (!apiKey) throw new InsightsUnavailableError("ANTHROPIC_API_KEY not configured");

  const client = new Anthropic({ apiKey });
  const { system, user } = buildInsightsPrompt(input);

  const response = await client.messages.create({
    model: INSIGHTS_MODEL,
    max_tokens: 2048,
    system,
    messages: [{ role: "user", content: user }],
    tools: [INSIGHTS_TOOL],
    // Force the tool so the model returns structure, not prose.
    tool_choice: { type: "tool", name: INSIGHTS_TOOL.name },
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === INSIGHTS_TOOL.name,
  );
  if (!toolUse) return [];
  return parseInsightsToolInput(toolUse.input);
}
