// Material domain constants + validation (docs/features/library-materials.md,
// D-69 merge of ClassContent/ClassMaterial into LibraryMaterial).
//
// A material's body is Markdown text rendered natively (react-markdown, raw
// HTML disabled). Keep these as named constants — the panels, the server
// actions, the AI compose ceiling, and the tests all read from here so
// nothing drifts.

import type { AppLocale } from "@/lib/i18n";

// How a material's body was authored — typed by the teacher, or drafted by
// the AI compose action and reviewed/edited before saving (provenance only).
// Kept as the `ClassContentSource` name — it's the Prisma enum name
// (`class_content_source` in the DB) and renaming it would be a schema churn
// with no behavioral benefit.
export type ClassContentSource = "manual" | "ai";

// Generous ceiling for a single material's body. Long enough for a full class
// plan (or a full worksheet) with examples; short enough to bound a row and an
// AI generation.
export const CLASS_CONTENT_MAX_CHARS = 20_000;

// Per-teacher monthly cap on AI compose generations (D-17: Pro + a monthly
// ceiling so token spend is bounded) — shared by class-content and
// library-material generation ("one AI plumbing, two outputs," one quota, not
// two). Generous for normal use; a teacher who hits it can still write
// content by hand. Tune here.
export const CLASS_CONTENT_AI_MONTHLY_CAP = 100;

// Per-material cap on stored version-history rows (task 5). Enough to undo a
// bad regenerate/overwrite several times over without the log growing
// unbounded; the oldest rows are pruned past this on every save.
export const CLASS_CONTENT_MAX_REVISIONS = 20;

// Max length of the free-text instruction a teacher gives the "Edit with AI"
// refine control ("change the date to March 5, shorten section 2"). A change
// request is a sentence or two, not a document; bounding it keeps the refine
// prompt (and cost) tight and stops a teacher pasting a whole new material into
// the instruction slot instead of generating fresh.
export const MATERIAL_REFINE_INSTRUCTION_MAX_CHARS = 1_000;

// Max length of a saved template's display name (task 3).
export const CLASS_CONTENT_TEMPLATE_LABEL_MAX_CHARS = 80;

// Sanity bound on how many templates one teacher can save in a single manager
// submission. Not a plan gate — just stops a pathological replace-set
// from writing an unbounded number of rows. Generous for a real method.
export const CLASS_CONTENT_TEMPLATE_MAX_PER_TEACHER = 100;

// How much of a teacher's lesson template we inject into the AI compose prompt
// as the section skeleton (D-46). A template body can be up to the full
// CLASS_CONTENT_MAX_CHARS ceiling, but the useful *structure* (headings + short
// hints) is small; bounding the injected slice keeps the prompt (and cost)
// tight and stops a teacher from pasting an entire filled lesson into the
// structure slot. Generous for a real skeleton.
export const CLASS_CONTENT_TEMPLATE_PROMPT_MAX_CHARS = 4_000;

// --- Lesson continuity ("continue from a previous class") ---

// How many previous-class materials a teacher can pick as continuation context
// for one generation. A handful is plenty to "combine context from several
// resources"; unbounded would let a crafted request bloat the prompt.
export const CLASS_CONTENT_CONTINUATION_MAX_MATERIALS = 5;

// How much of EACH selected previous material we inject into the prompt.
// Continuation only needs the gist (what was taught, roughly how far it got),
// not the full worksheet verbatim — bounding it per-material (rather than
// only the combined total) keeps one long previous class from crowding out
// the others when several are selected.
export const CLASS_CONTENT_CONTINUATION_MATERIAL_PROMPT_MAX_CHARS = 3_000;

// How many previous-booking materials the picker offers to choose from.
// Generous for "scroll back a few classes"; unbounded would make the picker
// itself (and the query backing it) unbounded.
export const CLASS_CONTENT_CONTINUATION_CANDIDATE_LIMIT = 20;

// --- Podcast generation (single-narrator TTS from a material's body) ---

// Upper bound on the spoken script we send to the TTS vendor, in characters.
// ElevenLabs caps a single request's input; this also bounds cost (TTS is
// metered per character) alongside the shared monthly AI cap. The script model
// is told to aim under this; the synth call slices to it as a hard backstop.
export const PODCAST_SCRIPT_MAX_CHARS = 8_000;

// Default target length for a generated podcast, in minutes. At ~150 spoken
// words/minute this shapes the script's word budget; the teacher doesn't pick
// a length in v1, so this is the single knob.
export const PODCAST_DEFAULT_DURATION_MIN = 4;

// Sanity bound on the rendered mp3 we accept back from the vendor + store, in
// bytes. A few minutes of 128kbps mono mp3 is well under this; it guards
// against a runaway/garbage response filling the bucket.
export const MAX_PODCAST_BYTES = 25 * 1024 * 1024; // 25 MB

// Spoken words per minute a single narrator averages — used both to size the
// script's word budget from a target duration and to estimate a finished
// podcast's duration from its script length (no ffmpeg probe).
export const PODCAST_WORDS_PER_MINUTE = 150;

// Start of the current calendar month in UTC — the window the cap counts over.
// UTC (not the teacher's tz) keeps it deterministic; the cap is generous enough
// that the boundary's exact local time doesn't matter.
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// Length of a body as it counts against the cap — CRLF collapsed to match how
// the body is normalized before storage. Powers the live character counter in
// the authoring UI so the 20k ceiling is never a silent truncation. Kept here
// (not trimmed) so the count tracks keystrokes; the save path trims, so this is
// a slight over-estimate near the very end, which is the safe direction.
export function classContentLength(raw: string): number {
  return raw.replace(/\r\n/g, "\n").length;
}

export type ClassContentValidation = { ok: true; body: string } | { ok: false; error: string };

// Validate + normalize a teacher-submitted (or AI-generated, teacher-reviewed)
// body. Trims, rejects empty, and enforces the ceiling. The body is never
// rendered as raw HTML, so this is a length/empty gate, not an HTML sanitizer.
export function validateClassContentBody(raw: string, locale: AppLocale): ClassContentValidation {
  const en = locale === "en";
  const body = raw.replace(/\r\n/g, "\n").trim();
  if (body.length === 0) {
    return {
      ok: false,
      error: en ? "Write some content first." : "Escribe primero algo de contenido.",
    };
  }
  if (body.length > CLASS_CONTENT_MAX_CHARS) {
    return {
      ok: false,
      error: en
        ? `Content is too long (max ${CLASS_CONTENT_MAX_CHARS.toLocaleString("en")} characters).`
        : `El contenido es demasiado largo (máx. ${CLASS_CONTENT_MAX_CHARS.toLocaleString("es-MX")} caracteres).`,
    };
  }
  return { ok: true, body };
}
