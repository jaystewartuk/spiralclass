import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { REPO_ROOT, walkTree } from "./_tree";

/**
 * No shell script in this repository pipes into a quiet grep.
 *
 * `producer | grep -q marker` under `set -o pipefail` fails when the marker is
 * FOUND early in a large input: GNU grep exits at its first match, the producer
 * takes EPIPE writing the rest, and pipefail reports the producer's failure as
 * the pipeline's. The 2026-09-13 production deploy of #98 shipped and went red
 * that way — the synthetic probe called a booking page with ten package links
 * "no purchasable package", because the first one was 16KB into a 134KB body.
 *
 * It is invisible on the laptop the scripts are written on: macOS's BSD grep
 * drains its input before exiting, so the same line passes there every time.
 * And a script without pipefail today can be sourced by one with it —
 * infisical.sh is, by push-github-secrets.sh — so this holds for every script,
 * not only the ones that set it.
 *
 * The replacement is always available: a here-string (`grep -q marker
 * <<<"$body"`), grep reading the file itself, or — for a remote command — a
 * `test -n "$(…)"`. scripts/local/synthetic.sh's own test runs it against pages
 * larger than a pipe buffer with a grep that stops reading early.
 */

const QUIET_GREP_IN_PIPELINE =
  /(?<!\|)\|(?!\|)\s*grep\s+(?:[^|;&]*\s)?(?:-[A-Za-z]*q[A-Za-z]*|--quiet|--silent)(?=\s|$)/;

/** Joins continuation lines, so a pipeline split across lines is read as one. */
function logicalLines(source: string): string[] {
  return source
    .replace(/\\\n/g, " ")
    .replace(/\|[ \t]*\n/g, "| ")
    .replace(/\n[ \t]*\|/g, " |")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"));
}

function shellScripts(): string[] {
  return [
    ...walkTree(REPO_ROOT, (name) => name.endsWith(".sh")),
    ...walkTree(join(REPO_ROOT, ".githooks")),
  ];
}

describe("no shell script pipes into a quiet grep", () => {
  it("recognises the shapes it forbids, and leaves alone the ones it recommends", () => {
    const flagged = (line: string) =>
      logicalLines(line).some((l) => QUIET_GREP_IN_PIPELINE.test(l));

    expect(flagged(`printf '%s' "$body" | grep -q "/sign-up"`)).toBe(true);
    expect(flagged(`echo "$x" | grep -qE 'a|b'`)).toBe(true);
    expect(flagged(`printf '%s' "$x" |\n  awk '{print $1}' | grep -Fxq "$k"`)).toBe(true);
    expect(flagged(`cmd \\\n  | grep -E -q x`)).toBe(true);
    expect(flagged(`cmd | grep --quiet x`)).toBe(true);

    expect(flagged(`grep -q "/sign-up" <<<"$body"`)).toBe(false);
    expect(flagged(`grep -qiE 'DROP TABLE' "$file"`)).toBe(false);
    expect(flagged(`test -d x || grep -q y file`)).toBe(false);
    expect(flagged(`cmd | grep -v quiet | sort`)).toBe(false);
    expect(flagged(`# not \`printf | grep -q\`, a here-string`)).toBe(false);
  });

  it("finds the repository's shell scripts, so the check below is not vacuous", () => {
    const scripts = shellScripts().map((file) => relative(REPO_ROOT, file));
    expect(scripts.length).toBeGreaterThan(30);
    expect(scripts).toContain("scripts/local/synthetic.sh");
    expect(scripts).toContain(".githooks/pre-push");
  });

  it("holds for every one of them", () => {
    const offenders = shellScripts().flatMap((file) =>
      logicalLines(readFileSync(file, "utf8"))
        .filter((line) => QUIET_GREP_IN_PIPELINE.test(line))
        .map((line) => `${relative(REPO_ROOT, file)}: ${line.trim()}`),
    );
    expect(
      offenders,
      "A pipe into `grep -q` fails under pipefail when the match comes early in a large input, " +
        'and only on GNU grep. Use a here-string instead: `grep -q marker <<<"$body"`.',
    ).toEqual([]);
  });
});
