import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * One definition of "the working tree", for the guards that walk it.
 *
 * WHY A FILESYSTEM WALK AT ALL, given `git ls-files` exists. Several of these
 * guards check things that are not yet committed — a file added by the branch
 * under test, a generated artefact — so they read the disk. That is correct and
 * is not what this module changes.
 *
 * WHAT IT CHANGES is how they decide what to skip. Five guards each carried
 * their own copy of the same hand-written list:
 *
 *   node_modules, .git, .next, .turbo, .gate, .venv-docs, dist, site,
 *   coverage, playwright-report, test-results
 *
 * — plus, in three of them, a separate `SKIP_PATHS` for `.claude/worktrees`,
 * added after other sessions' git worktrees made three guards fail on files no
 * edit to this checkout could fix (#1112). Every entry on both lists is a line
 * in `.gitignore`. It was `.gitignore`, restated five times, by hand, and it
 * had already drifted: nothing skipped `apps/web/dbml/`, `next-env.d.ts` or
 * `*.tsbuildinfo`, all generated, all gitignored, all walked.
 *
 * A restated list can only be right about the paths somebody remembered. Ask
 * git instead and a new ignored directory is skipped by every guard the moment
 * it is ignored — which is the same rule `gate.yml` follows when it reads the
 * Node major out of the Dockerfile rather than pinning its own.
 *
 * ⚠️ The one thing this deliberately does NOT do is skip untracked-but-not-
 * ignored files. A guard should still see a file somebody forgot to add.
 */

export const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

/**
 * Absolute paths git ignores, as directories where it can collapse them.
 *
 * `--directory` is what keeps this cheap: a wholly-ignored directory comes back
 * as one entry rather than as its contents, so `node_modules/` costs one line
 * instead of a hundred thousand. Measured at 13 entries and ~10ms on this tree.
 *
 * `.git` is added by hand because git does not report its own directory as
 * ignored — it is not in the worktree at all, so nothing asks.
 */
function ignoredPaths(): Set<string> {
  const listed = execFileSync(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\n")
    .filter(Boolean)
    .map((p) => join(REPO_ROOT, p.replace(/\/$/, "")));

  return new Set([join(REPO_ROOT, ".git"), ...listed]);
}

/** Computed once per test file; the tree does not change under a run. */
const IGNORED = ignoredPaths();

/**
 * Every file under `dir`, skipping anything git ignores.
 *
 * Returns absolute paths. Pass `keep` to filter by filename — the walk still
 * descends into every directory, so `keep` selects results rather than pruning.
 */
export function walkTree(
  dir: string = REPO_ROOT,
  keep: (name: string) => boolean = () => true,
  out: string[] = [],
): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (IGNORED.has(full)) continue;
    if (statSync(full).isDirectory()) walkTree(full, keep, out);
    else if (keep(entry)) out.push(full);
  }
  return out;
}
