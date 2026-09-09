// Mexico's indigenous languages — hand-curated, because CLDR cannot name them
// (D-72). Probe `nah`, `yua`, `mix`, `oto` through Intl.DisplayNames in any
// locale and you get `undefined`, which is exactly why these can't come from
// scripts/generate-languages.mjs like the 190 ISO 639-1 languages do.
//
// Codes are ISO 639-3. Spanish names follow INALI's `agrupación lingüística`
// naming (inali.gob.mx's Catálogo de las Lenguas Indígenas Nacionales), which is
// what a Mexican teacher would call her own language — not a literal translation
// of the English reference name.
//
// ⚠ INCOMPLETE ON PURPOSE. INALI recognizes 68 agrupaciones and 364 variantes.
// This file has the subset whose ISO 639-3 code is unambiguous and verifiable.
// The gap is the agrupaciones that map to a FAMILY of 639-3 codes with no single
// individual code standing for the whole group — Otomí, Totonaco, Mazateco,
// Chinanteco, Mixe, Zoque, Popoluca, Chatino, Triqui, Tepehua, Popoloca, Pame,
// Tepehuano. Each needs a call: adopt an ISO 639-2 collective code (`oto`), pick
// a representative variant, or model the group as a macro with real variants
// under it. That call needs INALI's actual catalogue, not recall — a wrong code
// here is worse than an absent one, because it silently mislabels a teacher's
// own language. See the D-72 follow-up.
//
// `macro: true` marks an ISO 639-3 macrolanguage: one code standing for variants
// that are often NOT mutually intelligible (Eastern Huasteca Nahuatl vs Highland
// Puebla Nahuatl). A teacher may pick the macro today; `parent` exists so real
// variants can be added later as rows, with no schema change.

import type { Language } from "./languages";

// None of these carry live captions: Deepgram has no streaming ASR for any of
// them, so `asr` is false throughout. That is a capability statement about the
// vendor, not about the language.
//
// None are AI-generatable either (`gen: false` throughout): these are exactly
// the low-resource languages Claude has little training data for, so a generated
// material would be unreliable in a way the teacher — the domain expert here —
// would have to catch and rewrite. Teaching them is fully supported; only the
// "let Claude draft it" shortcut is off.
export const MEXICAN_LANGUAGES: readonly Language[] = [
  // Macrolanguages — variants deferred to the INALI catalogue (see header).
  {
    code: "nah",
    label: { en: "Nahuatl", "es-MX": "náhuatl" },
    asr: false,
    gen: false,
    macro: true,
  },
  { code: "mix", label: { en: "Mixtec", "es-MX": "mixteco" }, asr: false, gen: false, macro: true },
  {
    code: "zap",
    label: { en: "Zapotec", "es-MX": "zapoteco" },
    asr: false,
    gen: false,
    macro: true,
  },

  // Mayan family.
  { code: "yua", label: { en: "Yucatec Maya", "es-MX": "maya" }, asr: false, gen: false },
  { code: "tzh", label: { en: "Tzeltal", "es-MX": "tseltal" }, asr: false, gen: false },
  { code: "tzo", label: { en: "Tzotzil", "es-MX": "tsotsil" }, asr: false, gen: false },
  { code: "ctu", label: { en: "Ch'ol", "es-MX": "ch'ol" }, asr: false, gen: false },
  { code: "hus", label: { en: "Huastec", "es-MX": "huasteco" }, asr: false, gen: false },
  { code: "toj", label: { en: "Tojolabal", "es-MX": "tojolabal" }, asr: false, gen: false },
  { code: "lac", label: { en: "Lacandon", "es-MX": "lacandón" }, asr: false, gen: false },
  { code: "kjb", label: { en: "Q'anjob'al", "es-MX": "q'anjob'al" }, asr: false, gen: false },
  { code: "kek", label: { en: "Q'eqchi'", "es-MX": "q'eqchi'" }, asr: false, gen: false },
  { code: "mam", label: { en: "Mam", "es-MX": "mam" }, asr: false, gen: false },
  { code: "quc", label: { en: "K'iche'", "es-MX": "k'iche'" }, asr: false, gen: false },
  { code: "cak", label: { en: "Kaqchikel", "es-MX": "kaqchikel" }, asr: false, gen: false },
  { code: "ixl", label: { en: "Ixil", "es-MX": "ixil" }, asr: false, gen: false },
  { code: "cac", label: { en: "Chuj", "es-MX": "chuj" }, asr: false, gen: false },
  { code: "jac", label: { en: "Jakalteko", "es-MX": "jakalteko" }, asr: false, gen: false },
  { code: "knj", label: { en: "Akateko", "es-MX": "akateko" }, asr: false, gen: false },
  { code: "agu", label: { en: "Awakateko", "es-MX": "awakateko" }, asr: false, gen: false },
  { code: "ttc", label: { en: "Tektiteko", "es-MX": "tektiteko" }, asr: false, gen: false },
  { code: "mhc", label: { en: "Mocho", "es-MX": "mocho" }, asr: false, gen: false },
  {
    code: "chf",
    label: { en: "Tabasco Chontal", "es-MX": "chontal de Tabasco" },
    asr: false,
    gen: false,
  },

  // Uto-Aztecan (beyond Nahuatl).
  { code: "hch", label: { en: "Huichol", "es-MX": "huichol (wixárika)" }, asr: false, gen: false },
  { code: "yaq", label: { en: "Yaqui", "es-MX": "yaqui" }, asr: false, gen: false },
  { code: "mfy", label: { en: "Mayo", "es-MX": "mayo" }, asr: false, gen: false },
  { code: "crn", label: { en: "Cora", "es-MX": "cora" }, asr: false, gen: false },
  { code: "var", label: { en: "Huarijio", "es-MX": "guarijío" }, asr: false, gen: false },
  {
    code: "ood",
    label: { en: "Tohono O'odham", "es-MX": "tohono o'odham (pápago)" },
    asr: false,
    gen: false,
  },

  // Oto-Manguean (the groups with an unambiguous individual code).
  { code: "maz", label: { en: "Mazahua", "es-MX": "mazahua" }, asr: false, gen: false },
  { code: "amu", label: { en: "Amuzgo", "es-MX": "amuzgo" }, asr: false, gen: false },
  { code: "cux", label: { en: "Cuicatec", "es-MX": "cuicateco" }, asr: false, gen: false },
  { code: "ixc", label: { en: "Ixcatec", "es-MX": "ixcateco" }, asr: false, gen: false },
  {
    code: "chd",
    label: { en: "Highland Chontal", "es-MX": "chontal de Oaxaca" },
    asr: false,
    gen: false,
  },
  {
    code: "pei",
    label: { en: "Chichimeca-Jonaz", "es-MX": "chichimeco jonaz" },
    asr: false,
    gen: false,
  },
  { code: "mat", label: { en: "Matlatzinca", "es-MX": "matlatzinca" }, asr: false, gen: false },
  {
    code: "ocu",
    label: { en: "Tlahuica", "es-MX": "tlahuica (ocuilteco)" },
    asr: false,
    gen: false,
  },

  // Tarascan (an isolate).
  { code: "tsz", label: { en: "Purépecha", "es-MX": "purépecha" }, asr: false, gen: false },

  // Yuman + isolates of the north.
  { code: "sei", label: { en: "Seri", "es-MX": "seri" }, asr: false, gen: false },
  { code: "klb", label: { en: "Kiliwa", "es-MX": "kiliwa" }, asr: false, gen: false },
  { code: "dih", label: { en: "Kumiai", "es-MX": "kumiai" }, asr: false, gen: false },
  { code: "ppi", label: { en: "Paipai", "es-MX": "paipai" }, asr: false, gen: false },
  { code: "coc", label: { en: "Cocopah", "es-MX": "cucapá" }, asr: false, gen: false },
  { code: "kic", label: { en: "Kickapoo", "es-MX": "kickapoo" }, asr: false, gen: false },
];
