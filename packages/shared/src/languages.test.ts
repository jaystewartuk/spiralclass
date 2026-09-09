import { describe, expect, it } from "vitest";
import {
  isCaptionLanguage,
  isGenerationLanguage,
  isLanguageCode,
  LANGUAGES,
  languageLabel,
  languageName,
  languageOptions,
} from "./languages";

// The one language registry (D-72). Replaces the old caption-languages /
// material-languages split, whose whole failure mode was two lists of the same
// thing drifting apart.

describe("LANGUAGES", () => {
  it("has unique lowercase BCP-47 codes", () => {
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toBe(code.toLowerCase());
  });

  it("labels every language in both locales", () => {
    for (const l of LANGUAGES) {
      expect(l.label.en.trim()).not.toBe("");
      expect(l.label["es-MX"].trim()).not.toBe("");
    }
  });

  // The capability flag is the ONLY thing separating a caption language from a
  // teachable one. If this ever became two lists again, that's the regression.
  it("carries a mix of captionable and teachable-only languages", () => {
    expect(LANGUAGES.some((l) => l.asr)).toBe(true);
    expect(LANGUAGES.some((l) => !l.asr)).toBe(true);
  });

  it("carries a mix of generatable and teachable-only languages", () => {
    expect(LANGUAGES.some((l) => l.gen)).toBe(true);
    expect(LANGUAGES.some((l) => !l.gen)).toBe(true);
  });

  // The registry shipped with SIX pairs of languages rendering an identical
  // label — `iw`/`he` both "Hebrew", `tw`/`ak` both "Akan", and the same for
  // in/id, jw/jv, ji/yi, mo/ro. Five were deprecated ISO 639-1 aliases that CLDR
  // still names, one a macrolanguage member CLDR names after its parent.
  //
  // Two identical chips is not just an eyesore: they're indistinguishable to the
  // teacher, and whichever she taps stores a DIFFERENT code, so one language
  // fragments across two values and every match on it silently misses. The
  // generator now drops the alias and fails loudly on a new collision; this pins
  // the property from the consuming side, where it actually matters.
  it("never renders two languages under the same label", () => {
    for (const locale of ["en", "es-MX"] as const) {
      const byLabel = new Map<string, string>();
      for (const l of LANGUAGES) {
        const label = l.label[locale];
        expect(
          byLabel.has(label),
          `${byLabel.get(label)} and ${l.code} both render ${JSON.stringify(label)} in ${locale}`,
        ).toBe(false);
        byLabel.set(label, l.code);
      }
    }
  });

  // The deprecated halves of those pairs, pinned by code so a regenerate against
  // a newer CLDR can't quietly reintroduce them.
  it("excludes deprecated ISO 639-1 aliases in favour of the modern code", () => {
    for (const [alias, modern] of [
      ["iw", "he"],
      ["in", "id"],
      ["jw", "jv"],
      ["ji", "yi"],
      ["mo", "ro"],
      ["tw", "ak"],
    ]) {
      expect(isLanguageCode(alias), `${alias} is deprecated; ${modern} is the modern code`).toBe(
        false,
      );
      expect(isLanguageCode(modern)).toBe(true);
    }
  });

  // Dropping "anything non-canonical" would have taken Filipino with it: `tl`
  // canonicalizes to `fil`, which is three letters and so never emitted by the
  // generator's two-letter sweep. ~90M speakers, deleted by a rule that looked
  // right. The rule is "same label", not "non-canonical" — this is why.
  it("keeps a language whose only code is a deprecated-looking alias", () => {
    expect(isLanguageCode("tl")).toBe(true);
    expect(languageName("tl")).toBe("Filipino");
  });
});

describe("isLanguageCode / isCaptionLanguage", () => {
  it("separates 'teachable' from 'captionable'", () => {
    // Thai: a real language a teacher may teach, below the ASR bar.
    expect(isLanguageCode("th")).toBe(true);
    expect(isCaptionLanguage("th")).toBe(false);
    expect(isCaptionLanguage("es")).toBe(true);
  });

  it("is case-insensitive and rejects unknown codes", () => {
    expect(isLanguageCode("ES")).toBe(true);
    expect(isCaptionLanguage("FR")).toBe(true);
    expect(isLanguageCode("klingon")).toBe(false);
    expect(isCaptionLanguage("klingon")).toBe(false);
  });
});

describe("isGenerationLanguage", () => {
  // Third axis on the same registry (teachable / captionable / generatable).
  // The picker it gates feeds a Claude prompt, and the registry spans every ISO
  // 639-1 language — so without a gate it offered to write a worksheet in
  // Avestan, an extinct liturgical language.
  it("separates 'teachable' from 'generatable'", () => {
    expect(isLanguageCode("ae")).toBe(true); // Avestan — in the registry…
    expect(isGenerationLanguage("ae")).toBe(false); // …but Claude cannot write it.
    expect(isGenerationLanguage("es")).toBe(true);
  });

  it("is an axis of its own, not a rename of the caption flag", () => {
    // Thai: Claude writes it well, Deepgram cannot stream-transcribe it.
    expect(isGenerationLanguage("th")).toBe(true);
    expect(isCaptionLanguage("th")).toBe(false);
  });

  it("excludes the low-resource languages the platform still fully supports teaching", () => {
    // Nahuatl is a first-class teaching language (languages.mx.ts) — the gate
    // must not be read as "unsupported language".
    expect(isLanguageCode("nah")).toBe(true);
    expect(isGenerationLanguage("nah")).toBe(false);
  });

  it("is case-insensitive and rejects unknown codes", () => {
    expect(isGenerationLanguage("ES")).toBe(true);
    expect(isGenerationLanguage("klingon")).toBe(false);
  });

  // Anthropic publishes measured scores for these and only these; the bar keeps
  // the ones at >=95% of English. Swahili (89.8%) and Yoruba (80.3%, 52.7% on
  // Haiku) are benchmarked but measurably degraded, so they sit below it —
  // pinned so "it's benchmarked" alone can't be mistaken for the bar.
  it("includes every Anthropic-benchmarked language at >=95% of English", () => {
    for (const code of [
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
    ]) {
      expect(isGenerationLanguage(code), `${code} is benchmarked >=95%`).toBe(true);
    }
    expect(isGenerationLanguage("sw")).toBe(false);
    expect(isGenerationLanguage("yo")).toBe(false);
  });
});

describe("languageLabel", () => {
  it("localizes", () => {
    // Spanish (CLDR) names languages in lowercase — languageLabel returns the
    // registry value verbatim; any first-letter capitalization is a display
    // concern, not this function's job.
    expect(languageLabel("pt", "es-MX")).toBe("portugués");
    expect(languageLabel("pt", "en")).toBe("Portuguese");
  });

  it("falls back to the raw code rather than throwing on a stray DB value", () => {
    expect(languageLabel("xx", "en")).toBe("xx");
  });
});

describe("languageName", () => {
  // The AI prompt is written in English and resolves an English language name
  // most reliably, so this is locale-independent by design.
  it("always returns the English name, whatever the reader's locale", () => {
    expect(languageName("fr")).toBe("French");
    // CLDR's English name for "zh" is "Chinese" (the registry is generated from
    // Intl.DisplayNames — see scripts/generate-languages.mjs).
    expect(languageName("zh")).toBe("Chinese");
  });

  it("falls back to the raw code", () => {
    expect(languageName("xx")).toBe("xx");
  });
});

describe("languageOptions", () => {
  it("sorts by localized label", () => {
    const labels = languageOptions("en").map((o) => o.label);
    expect(labels).toEqual([...labels].sort(new Intl.Collator("en").compare));
  });

  it("offers every language by default and only captionable ones on request", () => {
    expect(languageOptions("en")).toHaveLength(LANGUAGES.length);
    const captions = languageOptions("en", { captionsOnly: true });
    expect(captions.length).toBeLessThan(LANGUAGES.length);
    expect(captions.every((o) => isCaptionLanguage(o.code))).toBe(true);
    expect(captions.some((o) => o.code === "th")).toBe(false);
  });

  it("filters to generatable languages on request", () => {
    const gen = languageOptions("en", { generatableOnly: true });
    expect(gen.length).toBeLessThan(LANGUAGES.length);
    expect(gen.every((o) => isGenerationLanguage(o.code))).toBe(true);
    // Avestan is the reason this filter exists: a chip offering to have Claude
    // draft a worksheet in an extinct liturgical language.
    expect(gen.some((o) => o.code === "ae")).toBe(false);
    expect(gen.some((o) => o.code === "es")).toBe(true);
  });

  it("intersects the two filters rather than letting one win", () => {
    const both = languageOptions("en", { captionsOnly: true, generatableOnly: true });
    expect(both.every((o) => isCaptionLanguage(o.code) && isGenerationLanguage(o.code))).toBe(true);
  });

  // The picker this feeds renders one row per option with no search box, so an
  // unbounded list is the bug (190 chips buried the rest of the material form
  // deep enough that the E2E scroll gave up before reaching Save).
  it("keeps the generatable list small enough to render without a search box", () => {
    expect(languageOptions("en", { generatableOnly: true }).length).toBeLessThan(50);
  });
});
