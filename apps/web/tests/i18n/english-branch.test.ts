import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { usesEnglishCopy, DEFAULT_LOCALE, LOCALES } from "@spiralclass/shared";

/**
 * A two-armed English/Spanish string asks whether the reader is SPANISH.
 *
 * Plenty of copy is still written at the call site as `en ? english : spanish`
 * rather than as a catalog key. What decides `en` is the whole question. Ask
 * `locale === "en"` and every locale that is neither takes the Spanish arm —
 * so a French reader is handed Spanish, while the arm she should get is
 * English, which is `DEFAULT_LOCALE` and what every other part of the system
 * would have given her. Ask `locale !== "es-MX"` and the same call sites are
 * correct for every locale the registry will ever carry.
 *
 * The two predicates are indistinguishable while there are two locales, which
 * is why this is a test and not a code review note: the day a third locale
 * ships is the day hundreds of call sites change meaning at once, and nobody
 * is reading them then.
 *
 * `usesEnglishCopy` in @spiralclass/shared is the one definition. This fails on
 * a call site that goes back to comparing tags itself.
 */

const SRC = resolve(__dirname, "../../src");

/**
 * Comparing a locale against "en" to pick between two strings.
 *
 * Deliberately narrow: it matches an identifier ending in `locale` (or the bare
 * word) compared to "en", which is the shape every offending call site had. It
 * does not try to understand the expression around it — a test that guesses at
 * intent would need suppressions, and a suppression comment is how this rule
 * would quietly stop applying.
 */
const COMPARES_TO_EN = /\b[A-Za-z0-9_?.]*locale\s*===\s*"en"/;

/**
 * No file is exempt, and the empty set is the assertion.
 *
 * Several files still quote the shape in a comment explaining why they stopped
 * using it; `offendingLines` skips comment lines, so prose costs nothing here.
 * An entry in this set would be a call site allowed to keep the predicate that
 * is wrong — which is the one thing worth never allowing. If a legitimate need
 * ever appears, the entry belongs next to a note saying what makes it safe.
 */
const ALLOWED = new Set<string>([]);

function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

/** Lines that compare a locale to "en", ignoring comment lines. */
function offendingLines(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return false;
      return COMPARES_TO_EN.test(code);
    })
    .map((l) => l.trim());
}

describe("usesEnglishCopy", () => {
  it("gives every locale but Spanish the English arm", () => {
    for (const { tag } of LOCALES) {
      expect(usesEnglishCopy(tag), `${tag} took the wrong arm`).toBe(tag !== "es-MX");
    }
  });

  it("gives the English arm to a locale nobody has heard of, and to none at all", () => {
    // "we don't know" resolves the way DEFAULT_LOCALE does everywhere else.
    expect(usesEnglishCopy(undefined)).toBe(true);
    expect(usesEnglishCopy(null)).toBe(true);
    expect(usesEnglishCopy("pl")).toBe(true);
    expect(usesEnglishCopy(DEFAULT_LOCALE)).toBe(true);
  });

  it('is not the same predicate as `=== "en"`, which is the entire point', () => {
    const third: string | undefined = LOCALES.map((l) => l.tag).find(
      (t) => t !== "en" && t !== "es-MX",
    );
    expect(third, "no third locale — this guard has nothing to protect").toBeDefined();
    // The two predicates disagree here, and only here. `=== "en"` sends this
    // reader to the Spanish arm; the shipped one sends her to English.
    expect(usesEnglishCopy(third)).toBe(true);
    expect(third === "en").toBe(false);
  });
});

describe("call sites", () => {
  it('pick the English arm with usesEnglishCopy, not by comparing to "en"', () => {
    const offenders = sourceFiles()
      .map((file) => ({ file: relative(SRC, file), lines: offendingLines(file) }))
      .filter(({ file, lines }) => lines.length > 0 && !ALLOWED.has(file));

    expect(
      offenders.map(({ file, lines }) => `${file}\n    ${lines.join("\n    ")}`),
      `Comparing a locale to "en" decides which of two strings a reader sees, ` +
        `and answers it wrongly for every locale that is neither: a French ` +
        `reader takes the Spanish arm. Use usesEnglishCopy(locale) from ` +
        `@spiralclass/shared. If the comparison is picking an Intl locale ` +
        `rather than one of two strings, pass the locale itself instead.`,
    ).toEqual([]);
  });
});
