import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

// eslint-config-next 16 turns on the React Compiler half of
// eslint-plugin-react-hooks — set-state-in-effect, refs, purity,
// static-components, preserve-manual-memoization — at ERROR. They found 109
// existing violations across 72 files on the day Next 16 landed: real
// advisories, but a 109-site refactor of hooks in a payments app is not a
// thing to do inside a version bump, and turning the rules off would have
// bought the bump by giving up what they catch on everything written since.
//
// So the violations are recorded in eslint-suppressions.json — ESLint's own
// bulk-suppression mechanism, not a bespoke baseline like the i18n and
// design-token ratchets, because ESLint enforces it in both directions for
// free:
//   - a NEW violation is not in the file, so it is an error and the gate fails;
//   - a FIXED violation leaves a suppression that no longer matches, and
//     ESLint exits 2 with "There are suppressions left that do not occur
//     anymore" until it is pruned.
// Neither direction needs a test. What does need one is the file's scope: a
// bulk-suppression file is the easiest place in the repo to hide an error
// nobody meant to accept, so the rules it may cover are pinned here.
//
// To clear entries after fixing violations:
//   pnpm --filter spiralclass-web exec eslint src --prune-suppressions

const webRoot = resolve(process.cwd());
const suppressionsPath = resolve(webRoot, "eslint-suppressions.json");

/**
 * The only rules this file is allowed to suppress in bulk. Every one arrived
 * as an error in the Next 16 / eslint-plugin-react-hooks bump. Adding to this
 * list means accepting a new class of error repo-wide, which is a decision,
 * not a lint fix — say so in the change that does it.
 */
const SUPPRESSIBLE = new Set([
  "react-hooks/set-state-in-effect",
  "react-hooks/refs",
  "react-hooks/purity",
  "react-hooks/static-components",
  "react-hooks/preserve-manual-memoization",
]);

type Suppressions = Record<string, Record<string, { count: number }>>;

const suppressions = (): Suppressions =>
  JSON.parse(readFileSync(suppressionsPath, "utf8")) as Suppressions;

describe("eslint bulk suppressions", () => {
  it("is committed, so the runner and the laptop suppress the same set", () => {
    expect(existsSync(suppressionsPath)).toBe(true);

    // This test runs inside `git push`, which is not the same git context as
    // a terminal, and the pre-push hook is the run that matters — it is what
    // posts the local-gate status.
    //
    // git exports GIT_DIR to its hooks and leaves GIT_WORK_TREE unset. A git
    // command inheriting that pair skips repository discovery and treats the
    // CURRENT DIRECTORY as the work-tree root — so from apps/web,
    // `rev-parse --show-toplevel` answers apps/web, and a lookup for
    // `eslint-suppressions.json` at the root of HEAD's tree matches nothing
    // and reports a committed file as missing. Quietly: an empty result is not
    // an error. It passed everywhere else, CI included, because nothing else
    // sets the variable.
    //
    // Dropping the inherited pair puts discovery back, so cwd means what it
    // means in a terminal. Any check that shells out to git from inside a hook
    // needs this.
    const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, GIT_INDEX_FILE: _index, ...env } = process.env;
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: webRoot, encoding: "utf8", env }).trim();

    const repoRoot = git("rev-parse", "--show-toplevel");
    const fromRoot = relative(repoRoot, suppressionsPath).split(sep).join("/");

    // `--full-tree`, because `ls-tree` anchors its pathspec at the CURRENT
    // DIRECTORY otherwise — from apps/web it would look for
    // apps/web/apps/web/… and match nothing, in the same silent way.
    expect(
      git("ls-tree", "--full-tree", "--name-only", "HEAD", "--", fromRoot),
      `eslint-suppressions.json is not in HEAD.\n` +
        `  looked for: ${fromRoot}\n` +
        `  repo root:  ${repoRoot}\n` +
        `  cwd:        ${webRoot}`,
    ).toBe(fromRoot);
  });

  it("suppresses only the React Compiler rules the Next 16 bump turned on", () => {
    const unexpected: string[] = [];
    for (const [file, rules] of Object.entries(suppressions())) {
      for (const rule of Object.keys(rules)) {
        if (!SUPPRESSIBLE.has(rule)) unexpected.push(`${file} → ${rule}`);
      }
    }
    expect(
      unexpected,
      `eslint-suppressions.json is not a place to park an error. Fix these, or ` +
        `argue in the change for adding the rule to SUPPRESSIBLE:\n${unexpected.join("\n")}`,
    ).toEqual([]);
  });

  it("still has every suppressed rule configured at error, so new code is held to it", async () => {
    // The suppression file only hides the violations it lists. That is only
    // worth anything while the rule itself is still on and still fatal — a
    // rule quietly dropped to "warn" or "off" would leave this file looking
    // like a shrinking backlog while nothing was being enforced at all.
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({ cwd: webRoot });
    const config = (await eslint.calculateConfigForFile(resolve(webRoot, "src/app/page.tsx"))) as {
      rules?: Record<string, unknown[]>;
    };

    for (const rule of SUPPRESSIBLE) {
      const entry = config.rules?.[rule];
      expect(
        entry,
        `${rule} is no longer configured; its suppressions are dead weight`,
      ).toBeDefined();
      expect(entry?.[0], `${rule} must stay at error for code written since the bump`).toBe(2);
    }
  });

  it("records the violations that were there, not an empty promise", () => {
    // Guards the guard: an emptied file would make every assertion above pass
    // while the rules were, in effect, off for the whole tree.
    const counts = Object.values(suppressions()).flatMap((rules) =>
      Object.values(rules).map((r) => r.count),
    );
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((n) => n > 0)).toBe(true);
  });
});
