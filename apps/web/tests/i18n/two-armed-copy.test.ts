import { describe, expect, it } from "vitest";
// The scanner lives in scripts/ (plain ESM, outside src/) so it stays out of
// the coverage denominator; the test drives it here.
import { collectViolations, scanSource } from "../../scripts/two-armed-copy.mjs";

/**
 * No copy is chosen between an English string and a Spanish one.
 *
 * Every such call site was correct for two languages and wrong for every
 * other: a French reader got English for each, and the catalog's completeness
 * guard never saw a string that was never a key, so registering a locale did
 * not fail the build. This was a ratchet that could only shrink; it reached
 * zero (#178), the predicate `usesEnglishCopy` is deleted, and it is a ban.
 * Copy is a catalog key. A comparison that is not about copy — a vendor's
 * regional code — is a data table keyed by language.
 */
describe("two-armed copy", () => {
  it("is nowhere in the tree", () => {
    const violations = collectViolations();
    expect(
      violations,
      `These files pick between two authored strings instead of asking the ` +
        `catalog, so every locale but Spanish reads English there. Add a key ` +
        `to packages/shared/src/i18n and use t("key"):\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});

describe("two-armed copy scanner", () => {
  it("counts a call to the predicate and a comparison against Spanish", () => {
    expect(scanSource(`const en = usesEnglishCopy(locale);`)).toBe(1);
    expect(scanSource(`return languageCode === "es" ? "Hola" : "Hello";`)).toBe(1);
    expect(scanSource(`const en = locale !== "es";`)).toBe(1);
  });

  it("counts every call site on a line, not the line", () => {
    expect(scanSource(`f(usesEnglishCopy(a)); g(usesEnglishCopy(b));`)).toBe(2);
  });

  it("ignores prose about the shape, and comparisons against other values", () => {
    expect(scanSource(`// was: usesEnglishCopy(locale) ? en : es`)).toBe(0);
    expect(scanSource(` * the \`=== "es"\` branch below`)).toBe(0);
    expect(scanSource(`if (locale === "en") return;`)).toBe(0);
    expect(scanSource(`import { usesEnglishCopy } from "@spiralclass/shared";`)).toBe(0);
    expect(scanSource(`const umbrella = REGIONAL_UMBRELLA[lang];`)).toBe(0);
  });
});
