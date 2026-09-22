// Pronunciation config + the Phase D enablement gate (lesson-insights Phase D,
// the Phase D design, D-19). Mirrors the transcription
// gate: scoring stays dormant unless a vendor is configured AND the explicit
// flag is on. The flag matters because Phase D sends the student's voice to a
// SECOND external vendor (Azure) — D-21 cleared sending voice to an ASR vendor;
// the new-vendor coverage must be confirmed before flipping this on (see the
// doc's compliance note).
//
// Keys read straight from process.env (like the transcription layer) so an
// availability check never depends on the whole env schema validating.

export type PronunciationConfig = { key: string; region: string };

// Azure pronunciation assessment needs a key + region.
export function pronunciationConfig(): PronunciationConfig | null {
  const key = process.env.AZURE_SPEECH_KEY?.trim();
  const region = process.env.AZURE_SPEECH_REGION?.trim();
  if (!key || !region) return null;
  return { key, region };
}

function enablementFlagOn(): boolean {
  const raw = process.env.LESSON_INSIGHTS_PRONUNCIATION_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

// Both a vendor AND the flag are required.
export function pronunciationEnabled(): boolean {
  return enablementFlagOn() && pronunciationConfig() !== null;
}

// Azure pronunciation assessment supports a fixed language set; language coverage
// is the binding constraint (D-19). Gate conservatively by primary subtag —
// Spanish-first, English alongside — and skip anything else rather than sending
// an unsupported locale.
const SUPPORTED_PRIMARY = new Set(["es", "en"]);

export function isPronunciationLanguageSupported(language: string): boolean {
  return SUPPORTED_PRIMARY.has(primarySubtag(language));
}

function primarySubtag(language: string): string {
  return language.split("-")[0]!.toLowerCase();
}

// Azure wants a full locale (es-ES, en-US); the lesson stores a primary subtag
// ("es"). Pass a locale through untouched; map a bare subtag to a default.
export function toAzureLocale(language: string): string {
  if (language.includes("-")) return language;
  const primary = primarySubtag(language);
  if (primary === "es") return "es-ES";
  if (primary === "en") return "en-US";
  return language;
}
