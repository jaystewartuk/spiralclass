import Anthropic from "@anthropic-ai/sdk";
import type { IntroCoachFeedback } from "@spiralclass/shared";
import { anthropicApiKey } from "@/lib/env";

// AI intro-video coach (D-73, Layer 3). Reviews the transcript of a teacher's
// own public intro video and returns a warm overall take plus concrete
// strengths and actionable improvements — the differentiated payoff of owning
// the video. Teacher-only, Pro-gated at the pipeline. Mirrors lesson-notes/
// summary.ts: the prompt is built purely (unit-tested, no network) and the
// network call degrades via IntroCoachUnavailableError when no key is set.

// Haiku (D-87 — cost). Safe here because this is a short (max_tokens 1024) call
// that passes NO `output_config.effort` — `effort` 400s on pre-4.6 models
// including Haiku 4.5, which is why the effort-passing class-content compose
// path stayed on Sonnet 5. Adding `effort` here requires moving this constant
// to an effort-capable model in the same change. Hardcoded: ANTHROPIC_MODEL
// does NOT override this.
export const INTRO_COACH_MODEL = "claude-haiku-4-5";

// Raised when the platform has no Anthropic key configured, so the pipeline can
// skip feedback (leaving the transcript intact) rather than throw.
export class IntroCoachUnavailableError extends Error {}

export type IntroCoachInput = {
  // The teacher's spoken transcript (plain, joined utterances).
  transcript: string;
  // Video length in seconds, if known — lets the coach judge pacing/length.
  durationSec: number | null;
  // Language to write the feedback in (the teacher's language).
  en: boolean;
};

// The traits a good booking-page intro covers — fed to the model so its
// "improvements" are concrete and consistent rather than generic.
const CHECKLIST_EN =
  "who the classes are for, what makes the teacher's approach distinctive, a clear invitation to book, warmth/energy on camera, and a length around 30–60 seconds";
const CHECKLIST_ES =
  "para quién son las clases, qué hace distinto el enfoque de la profe, una invitación clara a reservar, calidez/energía frente a la cámara, y una duración de unos 30–60 segundos";

// Pure prompt builder — unit-tested without a network call. Asks for STRICT JSON
// so the response parses into IntroCoachFeedback.
export function buildIntroCoachPrompt(input: IntroCoachInput): { system: string; user: string } {
  const { en } = input;

  const system = en
    ? `You are a friendly coach helping a private teacher improve the short intro video on their public booking page. A great intro covers: ${CHECKLIST_EN}. Judge ONLY from the transcript (and length) provided — never invent what you can't hear. Be specific, warm and encouraging; a teacher should feel helped, not graded. Respond with STRICT JSON only, no prose around it, matching exactly: {"overall": string, "strengths": string[], "improvements": string[]}. "overall" is one or two sentences. "strengths" and "improvements" are 1–3 short, concrete bullet strings each. Write every string in English.`
    : `Eres una coach amable que ayuda a una profe particular a mejorar el video corto de presentación de su página pública de reservas. Una buena presentación incluye: ${CHECKLIST_ES}. Evalúa SOLO a partir de la transcripción (y la duración) proporcionada; nunca inventes lo que no puedas escuchar. Sé específica, cálida y alentadora; la profe debe sentirse apoyada, no calificada. Responde ÚNICAMENTE con JSON estricto, sin texto alrededor, con exactamente esta forma: {"overall": string, "strengths": string[], "improvements": string[]}. "overall" es una o dos frases. "strengths" e "improvements" son de 1 a 3 viñetas cortas y concretas cada una. Escribe cada texto en español.`;

  const lengthLine =
    input.durationSec != null
      ? en
        ? `Video length: about ${input.durationSec} seconds.`
        : `Duración del video: unos ${input.durationSec} segundos.`
      : en
        ? "Video length: unknown."
        : "Duración del video: desconocida.";

  const transcript =
    input.transcript.trim() || (en ? "(no speech detected)" : "(no se detectó voz)");

  const user = en
    ? `${lengthLine}\n\nTranscript of the teacher speaking:\n"""\n${transcript}\n"""\n\nReturn the JSON feedback.`
    : `${lengthLine}\n\nTranscripción de la profe hablando:\n"""\n${transcript}\n"""\n\nDevuelve la retroalimentación en JSON.`;

  return { system, user };
}

// Parse + validate the model's JSON into IntroCoachFeedback. Tolerates a fenced
// ```json block. Returns null on anything malformed so the caller can skip
// storing garbage.
export function parseIntroCoachFeedback(raw: string): IntroCoachFeedback | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const asStrings = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];
  const overall = typeof o.overall === "string" ? o.overall.trim() : "";
  const strengths = asStrings(o.strengths);
  const improvements = asStrings(o.improvements);
  if (!overall && strengths.length === 0 && improvements.length === 0) return null;
  return { overall, strengths, improvements };
}

// Generate coach feedback via Claude. Throws IntroCoachUnavailableError when no
// key is configured; lets SDK errors propagate. Returns null when the model's
// output can't be parsed (rare — we asked for strict JSON).
export async function generateIntroCoachFeedback(
  input: IntroCoachInput,
): Promise<IntroCoachFeedback | null> {
  const apiKey = anthropicApiKey();
  if (!apiKey) throw new IntroCoachUnavailableError("ANTHROPIC_API_KEY not configured");

  const client = new Anthropic({ apiKey });
  const { system, user } = buildIntroCoachPrompt(input);

  const response = await client.messages.create({
    model: INTRO_COACH_MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return parseIntroCoachFeedback(text);
}
