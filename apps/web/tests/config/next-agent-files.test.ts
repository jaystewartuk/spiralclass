import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// `next dev` writes AGENTS.md and CLAUDE.md into the app directory when it
// detects an AI coding agent, and re-adds its block on every start. Next 16
// gates that on `agentRules` in next.config (default true), and this app turns
// it off — see the comment on the option itself for why.
//
// The failure mode is not that the files are harmful. It is that they arrive
// without anyone choosing them: a dev server started for an unrelated reason
// writes two tracked-looking files, and the next `git add -A` commits them
// into whatever change happens to be open. That is exactly how they reached a
// commit on the Tailwind 4 branch, inside a spacing change they had nothing to
// do with, and it went unnoticed until a security review read the file list.
//
// So the guard is on the arrival, not on the content:
//   - the option stays off, so nothing is generated;
//   - neither file is tracked, so if the option is ever removed and a dev
//     server recreates them, the commit that adds them fails here rather than
//     riding along in an unrelated diff.
//
// If the Next block is wanted, it belongs in the root CLAUDE.md, written
// deliberately, where tests/config/claude-md.test.ts holds it and an upstream
// release cannot rewrite it.

const WEB_ROOT = resolve(__dirname, "../..");
const REPO_ROOT = resolve(WEB_ROOT, "../..");

const tracked = (pattern: string): string[] =>
  execFileSync("git", ["ls-files", "--", pattern], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

describe("next dev's generated agent files", () => {
  it("is disabled in next.config, which is what stops them being written", () => {
    const config = readFileSync(resolve(WEB_ROOT, "next.config.ts"), "utf8");
    expect(
      config,
      "next.config.ts must set `agentRules: false`, or `next dev` writes AGENTS.md " +
        "and CLAUDE.md into apps/web on its next start",
    ).toMatch(/^\s*agentRules:\s*false,\s*$/m);
  });

  it("leaves no AGENTS.md or CLAUDE.md under apps/web", () => {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      expect(
        existsSync(resolve(WEB_ROOT, name)),
        `apps/web/${name} is back. A dev server wrote it — delete it rather than ` +
          `committing it, and check why agentRules stopped being false.`,
      ).toBe(false);
    }
  });

  it("keeps the root CLAUDE.md as the only one in the repo", () => {
    // Guards the guard too: this fails if the glob stops matching anything,
    // since the root file must always be found.
    expect(tracked("*CLAUDE.md")).toEqual(["CLAUDE.md"]);
    expect(tracked("*AGENTS.md")).toEqual([]);
  });
});
