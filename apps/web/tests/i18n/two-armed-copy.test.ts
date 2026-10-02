import { describe, expect, it } from "vitest";
// The scanner lives in scripts/ (plain ESM, outside src/) so it stays out of
// the coverage denominator; the test drives it here.
import { collectCounts, loadBaseline, scanSource } from "../../scripts/two-armed-copy.mjs";

/**
 * Copy chosen between an English string and a Spanish one may not GROW.
 *
 * english-branch.test.ts, beside this, makes sure such a call site asks the
 * right question — "is this a Spanish reader?" — so that a third locale lands
 * on English rather than on Spanish. That makes the shape safe. It does not
 * make it right: a French reader still gets English for every one of them, and
 * the catalog's completeness guard never sees the string, so registering a
 * locale does not fail the build for it.
 *
 * This holds the number still, per file, while the call sites are moved into
 * the catalog. The baseline (scripts/two-armed-copy.baseline.json) is exact in
 * both directions: a file may not add a call site, and a file that loses one
 * must give the count back, so the baseline can never be looser than the tree
 * and a migrated file cannot quietly fill up again. Regenerate after migrating:
 *   node scripts/two-armed-copy.mjs --generate
 */
describe("two-armed copy ratchet", () => {
  const baseline = loadBaseline();
  const current = collectCounts();

  it("adds no new file that chooses between an English and a Spanish string", () => {
    const newOffenders = Object.keys(current).filter((file) => !(file in baseline));
    expect(
      newOffenders,
      `These files pick between two authored strings instead of asking the ` +
        `catalog, so every locale but Spanish reads English there. Add a key ` +
        `to packages/shared/src/i18n and use t("key"):\n${newOffenders.join("\n")}`,
    ).toEqual([]);
  });

  it("does not add a call site to a baselined file", () => {
    const regressions = Object.keys(current)
      .filter((file) => file in baseline && current[file] > baseline[file])
      .map((file) => `${file}: ${baseline[file]} → ${current[file]}`);
    expect(
      regressions,
      `Files added two-armed copy beyond their baseline. Use t("key") from the ` +
        `shared catalog instead:\n${regressions.join("\n")}`,
    ).toEqual([]);
  });

  it("gives back the count when a file is migrated", () => {
    const stale = Object.keys(baseline)
      .filter((file) => (current[file] ?? 0) < baseline[file])
      .map((file) => `${file}: ${baseline[file]} → ${current[file] ?? 0}`);
    expect(
      stale,
      `These files have fewer two-armed call sites than the baseline allows. ` +
        `That is the migration working — lock it in with ` +
        `\`node scripts/two-armed-copy.mjs --generate\`:\n${stale.join("\n")}`,
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
  });
});
