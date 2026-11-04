import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { scanSource } from "../../scripts/design-drift.mjs";

/**
 * `docs/development/exemplars.md` tells an agent which file to copy. A stale
 * row is worse than no row: it is followed rather than questioned, and it
 * spreads whatever the file has since become.
 *
 * So the qualities that make a file worth copying are asserted against the
 * file itself, and through checks that do not derive from the table (D-140).
 * This cannot prove that a file is good. It proves that a named file exists
 * and has not picked up the defects this repository already knows how to see.
 */

/** Vitest runs from the package root (apps/web). */
const REPO_ROOT = resolve(process.cwd(), "..", "..");
const WEB_SRC = "apps/web/src/";
const DOC = readFileSync(join(REPO_ROOT, "docs/development/exemplars.md"), "utf8");

const SUPPRESSIONS = /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|tenancy-exempt/;
const SKIPPED_TESTS = /\b(?:describe|it|test)\.(?:skip|only|todo)\b/;

type Row = { kind: string; exemplar: string; test: string | null };

function parseRows(markdown: string): Row[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("| ") && line.includes("`apps/web/"))
    .map((line) => {
      const [kind, exemplar, test] = line
        .split("|")
        .map((cell) => cell.trim())
        .slice(1);
      const unquote = (cell: string) => cell.match(/^`([^`]+)`$/)?.[1] ?? null;
      return { kind, exemplar: unquote(exemplar) ?? "", test: unquote(test) };
    });
}

const rows = parseRows(DOC);
const paths = rows.flatMap((row) => [row.exemplar, ...(row.test ? [row.test] : [])]);
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

describe("the exemplars table", () => {
  it("names one exemplar for each kind of change agents make most", () => {
    // Fixed here rather than read from the table, or deleting a row would pass.
    expect(rows.map((row) => row.kind)).toEqual([
      "Screen",
      "Client form",
      "Server action",
      "API handler",
      "Tenant-isolation test",
    ]);
  });

  it("gives every exemplar of production code a test", () => {
    const untested = rows.filter((row) => row.exemplar.startsWith(WEB_SRC) && !row.test);
    expect(untested).toEqual([]);
  });

  it("names only files that exist", () => {
    expect(paths.filter((path) => !existsSync(join(REPO_ROOT, path)))).toEqual([]);
  });

  it("names no file that suppresses a check", () => {
    expect(paths.filter((path) => SUPPRESSIONS.test(read(path)))).toEqual([]);
  });

  it("names no test file that skips or focuses a test", () => {
    const tests = paths.filter((path) => /\.test\.tsx?$/.test(path));
    expect(tests.length).toBeGreaterThanOrEqual(5);
    expect(tests.filter((path) => SKIPPED_TESTS.test(read(path)))).toEqual([]);
  });

  it("names no source file that bypasses the design tokens", () => {
    const sources = paths.filter((path) => path.startsWith(WEB_SRC) && !path.includes(".test."));
    expect(sources.length).toBeGreaterThanOrEqual(4);
    const drifting = sources.filter(
      (path) => Object.keys(scanSource(path.slice(WEB_SRC.length), read(path))).length > 0,
    );
    expect(drifting).toEqual([]);
  });
});

describe("the row parser", () => {
  it("reads a row with no test as having none", () => {
    expect(parseRows("| Kind | `apps/web/tests/a.test.ts` | — | Why |")).toEqual([
      { kind: "Kind", exemplar: "apps/web/tests/a.test.ts", test: null },
    ]);
  });

  it("flags the defects the table's checks look for", () => {
    expect(SUPPRESSIONS.test("// eslint-disable-next-line")).toBe(true);
    expect(SKIPPED_TESTS.test('it.skip("x", () => {});')).toBe(true);
    expect(SKIPPED_TESTS.test('it("x", () => {});')).toBe(false);
  });
});
