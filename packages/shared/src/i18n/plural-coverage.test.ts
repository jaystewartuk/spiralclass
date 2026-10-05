import { describe, expect, it } from "vitest";
import { strings } from "./catalog";
import { LOCALES, intlLocale, type AppLocale } from "./locales";

// Plurals: the base key is the "other" form, and `<key>_one`, `<key>_few`, …
// are the variants CLDR picks by count (translate.ts). A missing variant does
// not fail — it falls back to the base, which is the plural text, so a reader
// gets "1 forfaits". English needs only "one"; Russian needs "few" and "many",
// Arabic six categories. So for every counted key, each language must have a
// variant for every category its CLDR rules use (#178 step D3), or say here
// why falling back to the base form is grammatical for it.

/** Categories a language may leave to the base form, each with why. */
const FALLS_BACK_TO_BASE: Partial<Record<AppLocale, Record<string, string>>> = {
  es: {
    many: "Used for round millions; “1 000 000 clases” reads correctly in the base form.",
  },
  fr: {
    many: "Used for round millions; “1 000 000 cours” reads correctly in the base form.",
  },
};

const table = (locale: AppLocale) => strings[locale] as Record<string, string>;

/** Every base key that has a plural variant in any language: a counted string. */
const COUNTED = new Set(
  LOCALES.flatMap((l) =>
    Object.keys(table(l.tag))
      .map((key) => key.match(/^(.+)_(zero|one|two|few|many|other)$/)?.[1])
      .filter((base): base is string => base !== undefined),
  ),
);

describe("plural coverage", () => {
  it("finds the counted strings", () => {
    expect(COUNTED.size).toBeGreaterThan(50);
  });

  it.each(LOCALES.map((l) => l.tag))("%s: every counted string has each plural form", (locale) => {
    const categories = new Intl.PluralRules(intlLocale(locale)).resolvedOptions().pluralCategories;
    const allowed = FALLS_BACK_TO_BASE[locale] ?? {};
    const missing: string[] = [];
    for (const base of COUNTED) {
      const own = table(locale);
      if (!(base in own)) missing.push(`${base} (no base form)`);
      for (const category of categories) {
        if (category === "other" || category in allowed) continue;
        if (!(`${base}_${category}` in own)) missing.push(`${base}_${category}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
