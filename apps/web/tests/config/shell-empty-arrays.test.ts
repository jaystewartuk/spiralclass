import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, walkTree } from "./_tree";

// Every shell script here runs under `set -u`, and the operator's Mac runs them
// with /bin/bash 3.2 — `#!/usr/bin/env bash` finds nothing newer unless one was
// installed. Bash before 4.4 treats expanding an EMPTY array as an unbound
// variable: `"${a[@]}"`, `"${a[*]}"`, `for x in "${a[@]}"` and
// `b=("${a[@]}")` all abort the script. The runners are on bash 5, where every
// one of those is fine, so nothing in the gate ever sees the failure.
//
// It surfaced on 2026-09-23, on the first run of the region-move rehearsal:
// db-clone-to-region.sh died at `for t in "${EXCLUDE_TABLES[@]}"` whenever no
// --exclude-table was passed, under a comment calling that expansion safe.
// push-github-secrets.sh and e2e.sh had each already met the same trap and
// guarded against it by hand, which is why this is a check rather than a note.
//
// The rule: an array initialised empty (`NAME=()`) is only ever expanded as
// `${NAME[@]+"${NAME[@]}"}`, which is empty-safe on every bash. Its length,
// `${#NAME[@]}`, and a defaulted `${NAME[*]:-…}` are safe as they are.
//
// ⚠️ What this cannot see: an array that starts life non-empty and is emptied
// later, or one filled straight from command output. Neither exists in the tree
// today; declare it `NAME=()` first and the check covers it.

/** `path:line` for each expansion that aborts bash <4.4 when its array is empty. */
function unsafeEmptyArrayExpansions(path: string, source: string): string[] {
  const lines = source.split("\n");
  const code = lines.map((l) => (l.trimStart().startsWith("#") ? "" : l));
  const names = new Set<string>();
  for (const l of code) {
    const m = /^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)=\(\)\s*$/.exec(l);
    if (m) names.add(m[1]);
  }

  const found: string[] = [];
  code.forEach((l, i) => {
    for (const name of names) {
      const safe = new RegExp(`\\$\\{${name}\\[@\\]\\+"\\$\\{${name}\\[@\\]\\}"\\}`, "g");
      const bare = new RegExp(`\\$\\{${name}\\[[@*]\\]\\}`);
      if (bare.test(l.replace(safe, ""))) found.push(`${path}:${i + 1}  ${name}`);
    }
  });
  return found;
}

const SCRIPTS = [
  ...walkTree(REPO_ROOT, (name) => name.endsWith(".sh")),
  ...["pre-commit", "pre-merge-commit", "pre-push"].map((h) => join(REPO_ROOT, ".githooks", h)),
];

describe("shell scripts survive an empty array on macOS bash 3.2", () => {
  it("finds scripts to check", () => {
    expect(SCRIPTS.length).toBeGreaterThan(20);
  });

  it("expands every empty-initialised array in the empty-safe form", () => {
    const offenders = SCRIPTS.flatMap((f) =>
      unsafeEmptyArrayExpansions(relative(REPO_ROOT, f), readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  describe("the detector", () => {
    const check = (body: string) => unsafeEmptyArrayExpansions("x.sh", `A=()\n${body}\n`);

    it.each([
      ['cmd "${A[@]}"'],
      ['echo "${A[*]}"'],
      ['for x in "${A[@]}"; do :; done'],
      ['B=("${A[@]}" z)'],
    ])("flags %s", (body) => {
      expect(check(body)).toEqual(["x.sh:2  A"]);
    });

    it.each([
      ['cmd ${A[@]+"${A[@]}"}'],
      ['[ "${#A[@]}" -gt 0 ]'],
      ['echo "${A[*]:-none}"'],
      ['# a comment naming "${A[@]}"'],
      ['cmd "${AB[@]}"'],
    ])("passes %s", (body) => {
      expect(check(body)).toEqual([]);
    });

    it("ignores arrays that are never initialised empty", () => {
      expect(unsafeEmptyArrayExpansions("x.sh", 'A=(one two)\ncmd "${A[@]}"\n')).toEqual([]);
    });
  });
});
