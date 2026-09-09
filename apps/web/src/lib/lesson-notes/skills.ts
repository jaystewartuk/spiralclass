import type { InsightCategory } from "@prisma/client";
import type { StringKey, TFunction } from "@spiralclass/shared";

// Canonical skill taxonomy (lesson-insights Phase E,
// the Phase E design). The longitudinal profile groups
// confirmed insights by category + skill, so a finding needs a STABLE key to
// recur under across lessons. A code constant for v1 (Spanish-first), not a
// per-teacher table — the teacher confirms/changes the suggestion in the same
// ~10-second validation pass.
//
// `suggestSkill` matches an insight's category + summary against the taxonomy to
// pre-fill the teacher's choice; when nothing matches it falls back to a
// normalised slug of the summary, so the profile still has a usable grouping key.

// The canonical skill keys per category. Stable snake_case identifiers — display
// labels are localized in the UI via `skillLabel()` below, never derived from
// these.
export const SKILLS: Record<InsightCategory, string[]> = {
  grammar: [
    "subjunctive",
    "ser_vs_estar",
    "preterite_vs_imperfect",
    "gender_agreement",
    "por_vs_para",
    "articles",
    "prepositions",
    "conjugation",
    "pronouns",
    "agreement",
  ],
  pronunciation: ["vowels", "consonants", "rr_trill", "intonation", "stress", "linking"],
  vocabulary: ["theme", "false_friends", "register", "collocations"],
  fluency: ["hesitation", "pace", "filler_words", "self_correction"],
  comprehension: ["listening", "instructions", "idioms", "speed"],
};

// Keyword aliases (en + es, lowercased) that map an insight summary to a skill.
// First match wins; order within a category is most-specific-first where it
// matters. Heuristic by design — the teacher is the final say.
const SKILL_ALIASES: Partial<Record<string, string[]>> = {
  subjunctive: ["subjunctive", "subjunt", "subjuntivo"],
  ser_vs_estar: [
    "ser vs estar",
    "ser/estar",
    "ser and estar",
    "ser y estar",
    "ser o estar",
    "ser",
    "estar",
  ],
  preterite_vs_imperfect: ["preterite", "imperfect", "pretérito", "preterito", "imperfecto"],
  gender_agreement: [
    "gender",
    "género",
    "genero",
    "masculine",
    "feminine",
    "masculino",
    "femenino",
  ],
  por_vs_para: ["por vs para", "por/para", "por and para", "por y para", "por para"],
  articles: ["article", "artículo", "articulo", "definite", "indefinite"],
  prepositions: ["preposition", "preposición", "preposicion"],
  conjugation: ["conjugat", "conjuga", "verb ending", "verb form", "tense"],
  pronouns: ["pronoun", "pronombre", "object pronoun", "reflexive"],
  agreement: ["agreement", "concordancia", "agree"],
  vowels: ["vowel", "vocal"],
  consonants: ["consonant", "consonante"],
  rr_trill: ["rr", "trill", "rolled r", "vibrante", "erre"],
  intonation: ["intonation", "entonación", "entonacion"],
  stress: ["stress", "accent", "acento", "tonic", "tónica", "tonica"],
  linking: ["linking", "enlace", "liaison"],
  false_friends: ["false friend", "falso amigo", "cognate"],
  register: ["register", "formal", "informal", "registro", "formality"],
  collocations: ["collocation", "colocación", "colocacion"],
  hesitation: ["hesitat", "hesita", "duda", "titube"],
  pace: ["pace", "speed", "slow", "fast", "ritmo", "rapidez", "lento", "rápido", "rapido"],
  filler_words: ["filler", "muletilla", "um", "uh", "este…", "eh…"],
  self_correction: ["self-correct", "self correct", "autocorrec"],
  listening: ["listening", "escucha", "comprehension of", "understood"],
  instructions: ["instruction", "instrucción", "instruccion", "directions"],
  idioms: ["idiom", "modismo", "expression", "expresión", "expresion"],
  speed: ["too fast", "native speed", "rápido", "rapido", "velocidad"],
  theme: ["vocabulary", "vocabulario", "word", "palabra", "term", "término", "termino"],
};

// Normalise a free-text summary to a stable slug — the fallback grouping key when
// no taxonomy alias matches. Lowercase, strip accents/punctuation, words joined
// by underscores, bounded length.
export function normaliseSkill(summary: string): string {
  const slug = summary
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics (combining marks)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .split("_")
    .slice(0, 4)
    .join("_");
  return slug || "general";
}

// Suggest a skill key for an insight from its category + summary. Returns a
// taxonomy key when an alias matches (restricted to the category's skills), else
// a normalised-summary fallback so the profile always has a grouping key.
export function suggestSkill(category: InsightCategory, summary: string): string {
  const haystack = summary.toLowerCase();
  for (const skill of SKILLS[category]) {
    const aliases = SKILL_ALIASES[skill];
    if (aliases?.some((a) => haystack.includes(a))) return skill;
  }
  return normaliseSkill(summary);
}

// Whether a skill key is a recognised taxonomy entry for the category (vs a
// free-form fallback) — used to label the UI suggestion.
export function isCanonicalSkill(category: InsightCategory, skill: string): boolean {
  return SKILLS[category]?.includes(skill) ?? false;
}

// Every taxonomy key, flattened. Category-independent on purpose: a teacher can
// re-file a finding under another category while its skill stays put, so the
// label lookup must not depend on the category the key was declared under.
const ALL_SKILLS: ReadonlySet<string> = new Set(Object.values(SKILLS).flat());

/**
 * A skill's display label, in the reader's language.
 *
 * The comment on SKILLS has always claimed display labels are localized "never
 * derived from these" — until 2026-08-31 that was aspirational: both render
 * sites printed the raw snake_case key, so a teacher reading the app in Spanish
 * still saw `ser_vs_estar` and `filler_words`. The catalog keys now exist
 * (`insights.skill.*`) and this is the one place that resolves them.
 *
 * A skill invented by `normaliseSkill()` from a summary has no catalog key and
 * never will — it is a per-lesson string, not taxonomy — so it falls back to
 * its de-slugged form rather than rendering a missing-key placeholder.
 */
export function skillLabel(t: TFunction, skill: string): string {
  if (!ALL_SKILLS.has(skill)) return skill.replace(/_/g, " ");
  return t(`insights.skill.${skill}` as StringKey);
}
