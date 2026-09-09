// SpiralClass — the language registry.
//
// ONE list of languages, with a capability flag, serving every language surface
// in the product (D-72). Supersedes the split between the old
// `caption-languages.ts` (12 ASR-gated codes) and `material-languages.ts` (20
// English names): those were the same concept in two representations with two
// ranges, so they drifted — a teacher could generate Thai materials but the
// captions picker had never heard of Thai, and the same language was "th" in one
// place and "Thai" in the other.
//
// `code` (BCP-47) is the durable representation and the only thing stored. A
// display label is derived per locale; the English name is derived for AI
// prompts. Never store a label.
//
// `asr` and `gen` are capability gates, not second lists: a language below
// either bar is still perfectly teachable, you just can't caption a class in it
// (`asr`) or have Claude draft a material in it (`gen`). Both are set by
// scripts/generate-languages.mjs, whose header documents each bar; widen either
// only against evidence.
//
// `asr`: Deepgram's streaming ASR must transcribe the language well AND it must
// read naturally in the Claude translation prompt (D-27's original bar). A
// code outside the flag still "works" for captions in the degraded sense
// translate.ts describes, it just degrades UX.
//
// This platform is language-first (D-72): what a teacher teaches IS a language,
// so this registry also backs `teachers.target_language`.

import type { LocaleCode } from "./api";
import { WORLD_LANGUAGES } from "./languages.data";
import { MEXICAN_LANGUAGES } from "./languages.mx";

export type Language = {
  code: string;
  label: { en: string; "es-MX": string };
  // True when this language can carry live captions (streaming ASR +
  // translation quality). False = teachable but not captionable.
  asr: boolean;
  // True when Claude can reliably draft a teaching material in this language.
  // False = teachable but not AI-generatable (the registry spans every ISO 639-1
  // language, which includes extinct ones like Avestan and very low-resource
  // ones Claude has little data for).
  gen: boolean;
  // True for an ISO 639-3 macrolanguage: one code standing for variants that are
  // often NOT mutually intelligible (Nahuatl, Mixtec, Zapotec). Picking the
  // macro is valid — it means "the language, variant unspecified".
  macro?: boolean;
  // The macrolanguage this row is a variant of. Set on variants only; drives the
  // two-level picker. Empty today: Mexican variants wait on INALI's catalogue
  // (see languages.mx.ts), and the structure exists so adding them is data, not
  // a schema change.
  parent?: string;
};

export const LANGUAGES: readonly Language[] = [...WORLD_LANGUAGES, ...MEXICAN_LANGUAGES];

// The language a teacher teaches in / a class is captioned from by default.
export const DEFAULT_TEACHING_LANGUAGE = "es" as const;
// The language a student reads captions in by default.
export const DEFAULT_NATIVE_LANGUAGE = "en" as const;

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export function languageEntry(code: string): Language | undefined {
  return BY_CODE.get(code.toLowerCase());
}

/** True when `code` is a language this platform knows about at all. */
export function isLanguageCode(code: string): boolean {
  return BY_CODE.has(code.toLowerCase());
}

/**
 * True when `code` can carry live captions. The gate for anything caption-side
 * (teaching language, native language, per-class override) — NOT for what a
 * teacher may teach, which is every code in the registry.
 */
export function isCaptionLanguage(code: string): boolean {
  return languageEntry(code)?.asr === true;
}

/**
 * True when Claude can reliably draft a teaching material in `code`. The gate
 * for the AI-generation picker — NOT for what a teacher may teach, which is
 * every code in the registry.
 */
export function isGenerationLanguage(code: string): boolean {
  return languageEntry(code)?.gen === true;
}

/**
 * Localized display name, e.g. languageLabel("pt", "es-MX") → "Portugués".
 * Falls back to the raw code for anything outside the registry — keeps a stray
 * DB value from crashing a render rather than pretending it can't happen.
 */
export function languageLabel(code: string, locale: LocaleCode = "en"): string {
  const entry = languageEntry(code);
  if (!entry) return code;
  return locale === "es-MX" ? entry.label["es-MX"] : entry.label.en;
}

/**
 * The English name, for AI prompts ("Write the material in French"). Always
 * English regardless of the reader's locale: the instructions around it are
 * English, and the model resolves an English language name most reliably.
 */
export function languageName(code: string): string {
  return languageEntry(code)?.label.en ?? code;
}

/**
 * Languages as `{ code, label }`, localized and sorted by label in the caller's
 * locale. The filters are what separate a picker for one surface from another:
 * `captionsOnly` for a caption picker, `generatableOnly` for the AI-material
 * picker, neither for "what do you teach" (every code in the registry).
 */
export function languageOptions(
  locale: LocaleCode = "en",
  {
    captionsOnly = false,
    generatableOnly = false,
  }: { captionsOnly?: boolean; generatableOnly?: boolean } = {},
): { code: string; label: string }[] {
  const collator = new Intl.Collator(locale);
  return LANGUAGES.filter((l) => (!captionsOnly || l.asr) && (!generatableOnly || l.gen))
    .map((l) => ({ code: l.code, label: languageLabel(l.code, locale) }))
    .sort((a, b) => collator.compare(a.label, b.label));
}
