// Regenerates the world-language block of src/languages.data.ts from CLDR
// (D-72). Run with: node scripts/generate-languages.mjs
//
// Why generate rather than hand-maintain: Node's Intl.DisplayNames already
// carries CLDR's language names in every locale we ship, so the 190 ISO 639-1
// languages come out correct and bilingual for free. Why generate at BUILD time
// rather than call Intl at runtime: Hermes (React Native) ships a much weaker
// ICU than Node, and CLDR has no name at all for the Mexican indigenous
// languages this platform cares about (probe `nah`, `yua`, `mix` — all
// undefined, even in Node). So the runtime never calls Intl; it reads a table.
//
// Only ISO 639-1 (two-letter) codes are emitted. That is deliberately not "every
// ISO 639-3 code": the full set is ~7,900, ~95% of which CLDR cannot name in
// Spanish and essentially none of which anyone teaches. Languages outside 639-1
// that a teacher does teach — Nahuatl, Yucatec Maya, Purépecha — are curated by
// hand in MEXICAN_LANGUAGES, because that is exactly where CLDR fails.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const en = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
const es = new Intl.DisplayNames(["es-MX"], { type: "language", fallback: "none" });

// Live captions need Deepgram streaming ASR + a language that reads naturally in
// the Claude translation prompt (D-27's bar). Everything else is teachable
// but not captionable.
const ASR = new Set(["es", "en", "pt", "fr", "de", "it", "nl", "ja", "ko", "zh", "ru", "hi"]);

// AI material generation (materials.tsx). Like ASR, a capability gate rather
// than a second list — a language outside it is still teachable, you just can't
// have Claude draft the material for you.
//
// There is no authoritative list to copy: Anthropic publishes measured scores
// for 14 languages and otherwise says only that Claude "processes input and
// generates output in most world languages that use standard Unicode
// characters" (platform.claude.com/docs/en/build-with-claude/multilingual-support).
// So this bar is OURS, and it is two-tier:
//   1. Benchmarked by Anthropic at >=95% of English performance.
//   2. Unbenchmarked but high-resource, where Claude is well established.
// Swahili (89.8%) and Yoruba (80.3%, and 52.7% on Haiku) are benchmarked but
// measurably degraded, so they sit below the bar despite having numbers.
// Widen this only against evidence, the same way ASR asks for it.
const GEN = new Set([
  // 1. Benchmarked >=95%
  "en",
  "es",
  "pt",
  "it",
  "fr",
  "id",
  "de",
  "ar",
  "zh",
  "ko",
  "ja",
  "hi",
  "bn",
  // 2. Unbenchmarked, high-resource
  "ru",
  "nl",
  "pl",
  "tr",
  "vi",
  "th",
  "sv",
  "da",
  "no",
  "fi",
  "cs",
  "el",
  "he",
  "uk",
  "ro",
  "hu",
  "ta",
  "fa",
  "ms",
]);

// `tw` (Twi) is the one duplicate label the rule below cannot resolve on its
// own: CLDR names it "Akan" in both our locales — the same name as `ak`, because
// Twi is a member of the Akan macrolanguage — but BOTH codes are canonical, so
// neither is the obvious one to drop. There is no CLDR name that would tell them
// apart, so `tw` goes and `ak` stands for both.
const NAME_COLLISIONS = new Set(["tw"]);

/** True when `code` is the modern spelling, false for a deprecated alias. */
function isCanonical(code) {
  try {
    return Intl.getCanonicalLocales(code)[0] === code;
  } catch {
    return false; // not a well-formed tag at all
  }
}

const rows = [];
for (let i = 97; i <= 122; i++) {
  for (let j = 97; j <= 122; j++) {
    const code = String.fromCharCode(i) + String.fromCharCode(j);
    if (NAME_COLLISIONS.has(code)) continue;
    const enName = en.of(code);
    const esName = es.of(code);
    // Require BOTH names: a row we can only half-label is worse than absent,
    // because it renders as English to a Spanish teacher with no signal why.
    if (!enName || !esName) continue;
    rows.push({ code, en: enName, es: esName, asr: ASR.has(code), gen: GEN.has(code) });
  }
}

// Drop deprecated aliases — but only where the modern code is genuinely already
// here, which is precisely when the two share a label.
//
// The defect this fixes is two identical chips in the picker: `iw`/`he` both
// render "Hebrew", so the teacher can't tell them apart, and whichever they tap
// stores a different code — the same language fragments across two values and
// any match on it silently misses. Same for in/id, jw/jv, ji/yi, mo/ro.
//
// The rule is "same label" rather than the tempting "drop anything
// non-canonical", because those are NOT the same set and the difference deletes
// real languages. `tl` (Tagalog) canonicalizes to `fil`, which is three letters
// and so never emitted by the two-letter loop above — dropping `tl` for being
// non-canonical would remove Filipino, ~90M speakers, from the platform
// entirely. Its label is unique, so it stays, under the only code we can emit.
const byLabel = new Map();
for (const r of rows) {
  const existing = byLabel.get(r.en);
  if (!existing) {
    byLabel.set(r.en, r);
    continue;
  }
  const canonical = [existing, r].filter((x) => isCanonical(x.code));
  if (canonical.length !== 1) {
    throw new Error(
      `${existing.code} and ${r.code} both render ${JSON.stringify(r.en)} and neither is an ` +
        `unambiguous alias of the other. Add the one to drop to NAME_COLLISIONS.`,
    );
  }
  byLabel.set(r.en, canonical[0]);
}
const deduped = rows.filter((r) => byLabel.get(r.en) === r);
const dropped = rows.filter((r) => byLabel.get(r.en) !== r).map((r) => r.code);

rows.length = 0;
rows.push(...deduped);
rows.sort((a, b) => a.code.localeCompare(b.code));

for (const [flag, codes] of [
  ["ASR", ASR],
  ["GEN", GEN],
]) {
  const missing = [...codes].filter((c) => !rows.some((r) => r.code === c));
  if (missing.length > 0) {
    throw new Error(`${flag} codes missing from CLDR output: ${missing.join(", ")}`);
  }
}

// Backstop: the dedupe above keys on the English label, so a pair that collides
// ONLY in Spanish would slip through. Fail the generator rather than the picker.
for (const locale of ["en", "es"]) {
  const seen = new Map();
  for (const r of rows) {
    const label = r[locale];
    if (seen.has(label)) {
      throw new Error(
        `duplicate ${locale} label ${JSON.stringify(label)}: ${seen.get(label)} and ${r.code}. ` +
          `If they are genuinely the same language, add the one to drop to NAME_COLLISIONS.`,
      );
    }
    seen.set(label, r.code);
  }
}

const body = rows
  .map(
    (r) =>
      `  { code: ${JSON.stringify(r.code)}, label: { en: ${JSON.stringify(r.en)}, "es-MX": ${JSON.stringify(r.es)} }, asr: ${r.asr}, gen: ${r.gen} },`,
  )
  .join("\n");

const file = `// GENERATED by scripts/generate-languages.mjs — do not edit by hand.
// Regenerate with: node scripts/generate-languages.mjs
//
// The ${rows.length} canonical ISO 639-1 languages, named from CLDR in both
// shipped locales. Deprecated aliases (iw, in, jw, ji, mo) and CLDR name
// collisions (tw) are excluded by the generator — see its header for why.
// Hand-curated additions (Mexican indigenous languages, which CLDR cannot name)
// live in languages.mx.ts, not here.

import type { Language } from "./languages";

export const WORLD_LANGUAGES: readonly Language[] = [
${body}
];
`;

const dir = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(dir, "..", "src", "languages.data.ts"), file);
console.log(
  `wrote ${rows.length} languages (${[...ASR].length} captionable, ${[...GEN].length} generatable)` +
    (dropped.length > 0 ? `; dropped duplicate-label aliases: ${dropped.join(", ")}` : ""),
);
