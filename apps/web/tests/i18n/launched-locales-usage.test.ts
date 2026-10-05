import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, isLaunchedLocale } from "@spiralclass/shared";

// Anything that lists languages for a reader — a picker, a select, an
// hreflang set, structured data — reads LAUNCHED_LOCALES, so a language that
// has landed but not been reviewed reaches nobody (packages/shared
// launched-locales.test.ts proves the shared paths). LOCALES, the whole
// registry, is for resolving a value already stored. This holds the web app
// to that.

const SRC = join(__dirname, "..", "..", "src");

/** Files that may read the whole registry, each with its reason. */
const WHOLE_REGISTRY_ON_PURPOSE: Record<string, string> = {
  // A search for a page matches its nav label in every language, so a query
  // typed in any of them finds it. Nothing here is shown as a language choice.
  "lib/search/student-destinations.ts": "search terms",
  "lib/search/teacher-destinations.ts": "search terms",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("launched locales", () => {
  it("are what reader-facing code lists, never the whole registry", () => {
    const offenders = sourceFiles(SRC)
      .map((file) => relative(SRC, file))
      .filter((rel) => !(rel in WHOLE_REGISTRY_ON_PURPOSE))
      .filter((rel) => {
        const code = readFileSync(join(SRC, rel), "utf8")
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join("\n");
        return /(?<![A-Z_])LOCALES\b/.test(code);
      });
    expect(offenders, "use LAUNCHED_LOCALES").toEqual([]);
  });

  it("include the default, which every fallback lands on", () => {
    expect(isLaunchedLocale(DEFAULT_LOCALE)).toBe(true);
  });
});
