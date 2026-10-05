import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No locale is compared to "en" to choose what a reader sees.
 *
 * Copy chosen between an English and a Spanish string is banned outright
 * (two-armed-copy.test.ts, beside this): it is a catalog key now, for every
 * language. This keeps out the other half of the same shape. Ask
 * `locale === "en"` and every locale that is neither takes the other arm — so
 * a French reader was handed Spanish, while the arm she should have had was
 * English, DEFAULT_LOCALE, what every other part of the system would give
 * her. The two predicates are indistinguishable while there are two locales,
 * which is why this is a test and not a review note: a third locale changes
 * what every such line means at once, and nobody is reading them then.
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

describe("call sites", () => {
  it('never choose by comparing a locale to "en"', () => {
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
