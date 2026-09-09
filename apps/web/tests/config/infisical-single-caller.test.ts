import { readFileSync } from "node:fs";

import { REPO_ROOT, walkTree } from "./_tree";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// [D-169] EXACTLY ONE FILE RUNS THE INFISICAL CLI.
//
// Before it, ten call sites in nine files implemented four operations five
// different ways, and each learned the same lessons separately — so not all of
// them learned all of them. Two guards existed in exactly one of the five:
//
//   * An empty result is an ERROR, never an empty export. Falling through to a
//     bare `export` on a failed fetch dumps the whole shell environment, and
//     leaked OPENAI_API_KEY into a terminal and a chat transcript the first
//     time a script here shipped with a bad flag.
//   * The environment name is a CLOSED LIST. A typo makes `infisical run`
//     inject nothing, and the command then runs against whatever DATABASE_URL
//     is ambient — on a laptop, the one environment nobody meant to touch.
//
// Nothing stopped a sixth implementation appearing except somebody noticing, so
// this is what notices. A new `infisical secrets get` anywhere else fails here
// with the file that added it named.
//
// ⚠️ THE POINT IS NOT TIDINESS. Each of those guards is a real incident or a
// near one, and a wrapper is how a lesson learned once applies everywhere.

const WRAPPER = join("infra", "infisical", "infisical.sh");

// COMMAND POSITION ONLY: line start, a command substitution, a pipe or list
// operator, or `exec`. Anything else — a path like `infra/infisical/run.sh`, a
// backtick in a `fail "…"` message, `.infisical.json` — is prose or a
// reference, not a call.
//
// ⚠️ A looser rule was tried first and reported `scripts/oracle-deploy.sh`,
// whose only match is the word `infisical init` inside an error message. A
// guard that cries wolf gets deleted, so the precision matters.
const INVOCATION =
  /(?:^|\$\(|[(|;&]|\|\||&&|\bexec\s+)\s*infisical\s+(?:run|export|secrets|init|login)\b/;

/** Every file in the tree, from `./_tree`, which skips whatever git ignores. */
const walk = (dir: string = REPO_ROOT) => walkTree(dir);

/** A line that mentions the CLI in prose or prints it is not a call. */
function isExecutable(line: string): boolean {
  const t = line.trim();
  if (t === "" || t.startsWith("#")) return false;
  return INVOCATION.test(t);
}

const shellFiles = walk(REPO_ROOT)
  .filter((f) => f.endsWith(".sh"))
  .map((f) => relative(REPO_ROOT, f));

const callers = shellFiles.filter((file) =>
  readFileSync(join(REPO_ROOT, file), "utf8").split("\n").some(isExecutable),
);

describe("D-169: one wrapper owns every Infisical call", () => {
  // Guards the guard. A walk that returned nothing, or a regex that matched
  // nothing, would pass every assertion below having checked nothing at all —
  // which is the exact failure shape this whole area keeps producing.
  it("walks enough shell files, and still recognises a call when it sees one", () => {
    expect(shellFiles.length).toBeGreaterThan(20);
    expect(isExecutable('  out="$(infisical secrets get "$@" --env=preview)"')).toBe(true);
    expect(isExecutable("# infisical export is spelled --format, not --output")).toBe(false);
    expect(isExecutable('echo "confirm with: infisical secrets --env=preview"')).toBe(false);
    expect(isExecutable("exec infra/infisical/run.sh preview pnpm build")).toBe(false);
    // The false positive that shaped the regex: prose inside a message string.
    expect(isExecutable('fail "… or run \\`infisical init\\` in \\$HOME …"')).toBe(false);
  });

  it("names no shell file but the wrapper", () => {
    expect(callers).toEqual([WRAPPER]);
  });

  it("keeps all four verbs in the wrapper", () => {
    const src = readFileSync(join(REPO_ROOT, WRAPPER), "utf8");
    for (const verb of ["infisical_secrets", "infisical_env", "infisical_exec", "infisical_put"]) {
      expect(src, `${verb} left the wrapper`).toContain(`${verb}() {`);
    }
  });
});
