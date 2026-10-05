import { describe, expect, it } from "vitest";
import { strings } from "./catalog";
import { GLOSSARY } from "./glossary";
import { LOCALES } from "./locales";

// Each catalog keeps to its language's glossary (#178 step D4). The French
// catalog said "profe", which is Spanish, 25 times before this existed.

const values = (locale: string) =>
  Object.values((strings as Record<string, Record<string, string>>)[locale]);

describe("the glossary", () => {
  it("exists for every registered language", () => {
    for (const { tag } of LOCALES) expect(GLOSSARY[tag], tag).toBeDefined();
  });

  it.each(LOCALES.map((l) => l.tag))(
    "%s: the catalog uses none of its forbidden words",
    (locale) => {
      for (const { pattern, why } of GLOSSARY[locale].forbidden) {
        const hits = values(locale).filter((v) => pattern.test(v));
        expect(hits, `${pattern} — ${why}`).toEqual([]);
      }
    },
  );

  // A glossary term the catalog never uses describes some other product.
  it.each(LOCALES.map((l) => l.tag))("%s: every term is one the catalog uses", (locale) => {
    const text = values(locale).join("\n").toLowerCase();
    for (const [concept, term] of Object.entries(GLOSSARY[locale].terms)) {
      expect(text.includes(term.toLowerCase()), `${concept}: "${term}"`).toBe(true);
    }
  });
});
