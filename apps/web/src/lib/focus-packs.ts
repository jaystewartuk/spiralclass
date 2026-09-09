// Focus-tag seed packs — docs/features/classes-lesson-content.md, D-20, narrowed to
// language-first by D-72.
//
// The single source of truth for the "what to work on" defaults a teacher starts
// with. The language-flavored content is DATA (seed rows), not schema: a
// teacher's pack is chosen by the language she teaches
// (`teachers.target_language`), the same call the Level table makes by seeding
// CEFR. Adding a language's pack is a new pack here — no migration, no code
// branching elsewhere.
//
// D-72 removed the music/math/generic packs and the `discipline` concept that
// selected them: this platform teaches languages. What survives is the packs
// themselves plus `focusTagSeedFor(targetLanguage)`.
//
// `code` is a stable per-teacher key (pack-prefixed so packs never collide if a
// teacher who teaches two languages gets two packs seeded). `label` is the
// display string, written in the language's natural metalanguage (Spanish
// grammar terms for the Spanish pack) and, like Level.label, not translated.
// `category` picks which of the seeded FocusTagCategory rows the tag is filed
// under — a soft grouping the teacher can later reassign, rename, or delete via
// @/lib/focus-tags.

export type FocusTagCategory = "grammar" | "vocabulary" | "skill" | "activity" | "theme" | "format";

// Order categories are shown in the picker.
export const FOCUS_TAG_CATEGORY_ORDER: FocusTagCategory[] = [
  "grammar",
  "vocabulary",
  "skill",
  "activity",
  "theme",
  "format",
];

// The 5 categories every teacher's `focus_tag_categories` starts with
// (ensureTeacherFocusCategories seeds these, idempotently, the same way
// ensureTeacherFocusTags seeds the language pack). Unlike tag labels —
// frozen forever in the pack's natural language — a category's label is
// stored per-teacher at seed time in *her current UI locale*, because
// FocusTagCategory is a real, teacher-owned row she's free to rename
// afterward (this is the one place "category" behaves like ordinary data
// instead of pack content). This is the single source of truth for those
// labels — the old per-file `CATEGORY_LABELS` duplicates (web ×3, mobile ×1)
// are gone; a category's `label` column IS the display string now.
export const FOCUS_TAG_BUILTIN_CATEGORIES: {
  code: FocusTagCategory;
  labelEn: string;
  labelEs: string;
}[] = [
  { code: "grammar", labelEn: "Grammar", labelEs: "Gramática" },
  { code: "vocabulary", labelEn: "Vocabulary", labelEs: "Vocabulario" },
  { code: "skill", labelEn: "Skills", labelEs: "Habilidades" },
  { code: "activity", labelEn: "Activities", labelEs: "Actividades" },
  { code: "theme", labelEn: "Themes", labelEs: "Temas" },
  { code: "format", labelEn: "Format", labelEs: "Formato" },
];

// ---- Format tags — subject-agnostic, seeded for every teacher -------------
//
// "What kind of material is this" (worksheet, reading, song, quiz…) doesn't
// vary by language the way grammar/vocabulary do, so unlike the packs
// above, these are layered onto EVERY teacher's tags regardless of
// language (see ensureTeacherFocusTags in focus-tags.ts) rather than picked
// per-pack. Sourced from the material types a working Spanish teacher
// actually uses (profedeele.es); useful well beyond language teaching. Each
// carries its own bilingual label (unlike the discipline packs, which are
// frozen in one language) since the format axis itself is language-neutral.
export type FormatTagSeed = { key: string; labelEs: string; labelEn: string };

export const FORMAT_TAG_SEEDS: FormatTagSeed[] = [
  { key: "actividad_breve", labelEs: "Actividad breve", labelEn: "Short activity" },
  { key: "presentacion", labelEs: "Presentación", labelEn: "Presentation" },
  { key: "lecturas", labelEs: "Lecturas", labelEn: "Readings" },
  { key: "ponte_al_dia", labelEs: "Ponte al día", labelEn: "Current events" },
  { key: "unidad_didactica", labelEs: "Unidad didáctica", labelEn: "Teaching unit" },
  { key: "test", labelEs: "Test", labelEn: "Quiz" },
  { key: "cancion", labelEs: "Canción", labelEn: "Song" },
  { key: "podcast", labelEs: "Pódcast", labelEn: "Podcast" },
  { key: "escape_room", labelEs: "Escape Room", labelEn: "Escape Room" },
  { key: "kahoot", labelEs: "Kahoot", labelEn: "Kahoot" },
];

export type FocusTagSeed = {
  // Key WITHIN a pack; the stored code is `${packKey}:${key}`.
  key: string;
  label: string;
  category: FocusTagCategory;
};

// ---- Seed packs -----------------------------------------------------------

// A Spanish teacher teaching in Spanish. Labels are written in Spanish, the
// natural metalanguage of the lesson (they are NOT translated, like Level
// labels). Curated to cover the axes a Spanish class actually turns on: the
// full indicative/subjunctive tense system, the classic contrast pairs
// (ser/estar, por/para, indefinido/imperfecto), the everyday vocabulary
// domains, the four skills plus pronunciation and spelling, the activity
// shapes a lesson takes, and the thematic topics (including profedeele.es's
// "Categoría"/"Temática" facets).
const SPANISH_PACK: FocusTagSeed[] = [
  // Grammar — the backbone of a Spanish lesson.
  { key: "presente", label: "Presente de indicativo", category: "grammar" },
  { key: "preterito_indefinido", label: "Pretérito indefinido", category: "grammar" },
  { key: "preterito_imperfecto", label: "Pretérito imperfecto", category: "grammar" },
  { key: "indefinido_imperfecto", label: "Indefinido vs. imperfecto", category: "grammar" },
  { key: "preterito_perfecto", label: "Pretérito perfecto", category: "grammar" },
  { key: "pluscuamperfecto", label: "Pretérito pluscuamperfecto", category: "grammar" },
  { key: "futuro", label: "Futuro", category: "grammar" },
  { key: "condicional", label: "Condicional", category: "grammar" },
  { key: "subjuntivo_presente", label: "Subjuntivo presente", category: "grammar" },
  { key: "subjuntivo_imperfecto", label: "Subjuntivo imperfecto", category: "grammar" },
  { key: "imperativo", label: "Imperativo", category: "grammar" },
  { key: "ser_estar", label: "Ser vs. estar", category: "grammar" },
  { key: "por_para", label: "Por vs. para", category: "grammar" },
  { key: "pronombres", label: "Pronombres de objeto", category: "grammar" },
  { key: "reflexivos", label: "Verbos reflexivos", category: "grammar" },
  { key: "perifrasis", label: "Perífrasis verbales", category: "grammar" },
  { key: "preposiciones", label: "Preposiciones", category: "grammar" },
  { key: "comparativos", label: "Comparativos y superlativos", category: "grammar" },
  // Vocabulary domains.
  { key: "vocab_comida", label: "Comida", category: "vocabulary" },
  { key: "vocab_viajes", label: "Viajes", category: "vocabulary" },
  { key: "vocab_trabajo", label: "Trabajo", category: "vocabulary" },
  { key: "vocab_familia", label: "Familia", category: "vocabulary" },
  { key: "vocab_salud", label: "Salud", category: "vocabulary" },
  { key: "vocab_tecnologia", label: "Tecnología", category: "vocabulary" },
  { key: "vocab_casa_ciudad", label: "Casa y ciudad", category: "vocabulary" },
  { key: "vocab_ocio", label: "Ocio y tiempo libre", category: "vocabulary" },
  // Skills.
  { key: "skill_comprension_auditiva", label: "Comprensión auditiva", category: "skill" },
  { key: "skill_comprension_lectora", label: "Comprensión lectora", category: "skill" },
  { key: "skill_expresion_oral", label: "Expresión oral", category: "skill" },
  { key: "skill_expresion_escrita", label: "Expresión escrita", category: "skill" },
  { key: "skill_pronunciacion", label: "Pronunciación", category: "skill" },
  // "Ortografía" (spelling) — one of profedeele.es's coarse "Categoría"
  // facets; it's a language skill in the same sense as the others above.
  { key: "skill_ortografia", label: "Ortografía", category: "skill" },
  // Activity types.
  { key: "act_conversacion", label: "Conversación / role-play", category: "activity" },
  { key: "act_lectura", label: "Lectura", category: "activity" },
  { key: "act_gramatica", label: "Ejercicios de gramática", category: "activity" },
  { key: "act_juego", label: "Juego / quiz", category: "activity" },
  { key: "act_tarea", label: "Tarea", category: "activity" },
  // "Exámenes" and "Funciones (comunicativas)" — the other two coarse
  // profedeele.es "Categoría" facets without a direct existing home; both
  // are things a lesson DOES, so "activity" fits them the same way it
  // already fits conversación/lectura/juego above.
  { key: "act_examen", label: "Exámenes", category: "activity" },
  { key: "act_funciones", label: "Funciones comunicativas", category: "activity" },
  // Themes ("Temáticas" — profedeele.es's own thematic-topic facet, the
  // same shape as the two already here).
  { key: "theme_cultura", label: "Cultura mexicana", category: "theme" },
  { key: "theme_actualidad", label: "Actualidad", category: "theme" },
  { key: "theme_cultura_general", label: "Cultura", category: "theme" },
  { key: "theme_paises_hispanos", label: "Países hispanos", category: "theme" },
  { key: "theme_negocios", label: "Español de negocios", category: "theme" },
  { key: "theme_espanol_terapia", label: "Español terapia", category: "theme" },
  { key: "theme_valores", label: "Valores", category: "theme" },
  { key: "theme_fines_especificos", label: "Fines específicos", category: "theme" },
  { key: "theme_ele_ninos", label: "ELE para niños", category: "theme" },
];

// An English teacher teaching in English. Labels in English, and curated to
// the same depth as the Spanish pack (parity): the full tense system plus the
// structures an English course actually drills (passive, reported speech,
// gerunds/infinitives, relative clauses, phrasal/modal verbs), everyday
// vocabulary domains, the four skills plus pronunciation and spelling, the
// activity shapes, and thematic topics (business, exams, culture, kids…).
const ENGLISH_PACK: FocusTagSeed[] = [
  // Grammar.
  { key: "present_simple", label: "Present simple", category: "grammar" },
  { key: "present_continuous", label: "Present continuous", category: "grammar" },
  { key: "past_simple", label: "Past simple", category: "grammar" },
  { key: "past_continuous", label: "Past continuous", category: "grammar" },
  { key: "present_perfect", label: "Present perfect", category: "grammar" },
  { key: "past_perfect", label: "Past perfect", category: "grammar" },
  { key: "future", label: "Future (will / going to)", category: "grammar" },
  { key: "conditionals", label: "Conditionals", category: "grammar" },
  { key: "modals", label: "Modal verbs", category: "grammar" },
  { key: "phrasal_verbs", label: "Phrasal verbs", category: "grammar" },
  { key: "passive_voice", label: "Passive voice", category: "grammar" },
  { key: "reported_speech", label: "Reported speech", category: "grammar" },
  { key: "gerunds_infinitives", label: "Gerunds & infinitives", category: "grammar" },
  { key: "articles", label: "Articles", category: "grammar" },
  { key: "prepositions", label: "Prepositions", category: "grammar" },
  { key: "comparatives", label: "Comparatives & superlatives", category: "grammar" },
  { key: "relative_clauses", label: "Relative clauses", category: "grammar" },
  // Vocabulary domains.
  { key: "vocab_food", label: "Food", category: "vocabulary" },
  { key: "vocab_travel", label: "Travel", category: "vocabulary" },
  { key: "vocab_work", label: "Work", category: "vocabulary" },
  { key: "vocab_family", label: "Family", category: "vocabulary" },
  { key: "vocab_health", label: "Health", category: "vocabulary" },
  { key: "vocab_technology", label: "Technology", category: "vocabulary" },
  { key: "vocab_home_city", label: "Home & city", category: "vocabulary" },
  { key: "vocab_leisure", label: "Leisure & free time", category: "vocabulary" },
  // Skills.
  { key: "skill_listening", label: "Listening", category: "skill" },
  { key: "skill_reading", label: "Reading", category: "skill" },
  { key: "skill_speaking", label: "Speaking", category: "skill" },
  { key: "skill_writing", label: "Writing", category: "skill" },
  { key: "skill_pronunciation", label: "Pronunciation", category: "skill" },
  { key: "skill_spelling", label: "Spelling", category: "skill" },
  // Activity types.
  { key: "act_conversation", label: "Conversation / role-play", category: "activity" },
  { key: "act_reading", label: "Reading", category: "activity" },
  { key: "act_grammar", label: "Grammar drills", category: "activity" },
  { key: "act_game", label: "Game / quiz", category: "activity" },
  { key: "act_homework", label: "Homework", category: "activity" },
  { key: "act_exam", label: "Exams (IELTS / TOEFL / Cambridge)", category: "activity" },
  { key: "act_functions", label: "Functional language", category: "activity" },
  // Themes.
  { key: "theme_business", label: "Business English", category: "theme" },
  { key: "theme_current_events", label: "Current events", category: "theme" },
  { key: "theme_culture", label: "Culture & customs", category: "theme" },
  { key: "theme_kids", label: "English for kids", category: "theme" },
  { key: "theme_esp", label: "English for specific purposes", category: "theme" },
  { key: "theme_idioms", label: "Idioms & expressions", category: "theme" },
];

// A neutral pack for any other language (French, Italian, …) — the axes a
// language lesson always has, without language-specific grammar terms.
const LANGUAGE_PACK: FocusTagSeed[] = [
  { key: "grammar_focus", label: "Grammar focus", category: "grammar" },
  { key: "verb_tenses", label: "Verb tenses", category: "grammar" },
  { key: "vocab", label: "Vocabulary", category: "vocabulary" },
  { key: "skill_listening", label: "Listening", category: "skill" },
  { key: "skill_reading", label: "Reading", category: "skill" },
  { key: "skill_speaking", label: "Speaking", category: "skill" },
  { key: "skill_writing", label: "Writing", category: "skill" },
  { key: "skill_pronunciation", label: "Pronunciation", category: "skill" },
  { key: "act_conversation", label: "Conversation / role-play", category: "activity" },
  { key: "act_homework", label: "Homework", category: "activity" },
];

// Packs keyed by the language taught. Spanish and English get a hand-written
// pack with that language's real grammar points; every other language falls back
// to LANGUAGE_PACK — the axes a language lesson always has, without
// language-specific grammar terms. Add a pack here as a language earns one.
const PACKS: Record<string, FocusTagSeed[]> = {
  es: SPANISH_PACK,
  en: ENGLISH_PACK,
};

// Pack key for a language code, for the pack-prefixed tag codes. Anything
// without its own pack shares the neutral "language" prefix.
function packKeyFor(targetLanguage: string | null | undefined): string {
  const code = targetLanguage?.toLowerCase();
  return code && PACKS[code] ? code : "language";
}

// Resolve the language a teacher teaches (possibly null/unknown) to its ordered
// seed pack. Unknown or unset → the neutral language pack, so there is always a
// usable default. Replaces D-20's focusTagSeedFor(discipline).
export function focusTagSeedFor(targetLanguage: string | null | undefined): {
  pack: string;
  seeds: FocusTagSeed[];
} {
  const key = packKeyFor(targetLanguage);
  return { pack: key, seeds: PACKS[key] ?? LANGUAGE_PACK };
}
