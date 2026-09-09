import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { REPO_ROOT, walkTree } from "./_tree";

/**
 * Every `docs/…` path written anywhere in the repo must name a file that exists.
 *
 * WHY THIS EXISTS. Nothing checked doc paths, and they rotted in silence
 * through three separate events: the 2026-07-24 reorg moved `docs/ops/*` and
 * `docs/engineering/*` into purpose-grouped folders, [D-110](../../../../docs/decisions/D-110.md)
 * deleted every backlog document, and a workspace deletion took another set. Each
 * left the references behind. By 2026-09-06 there were 278 dangling pointers:
 * 87 to documents that had simply MOVED (one of them in an admin UI string a
 * reader was told to go and open), and 259 citations of deleted BACKLOG specs
 * that were repointed at the live doc describing what got built from them.
 * All of those are fixed; this stops the next batch.
 *
 * `check-links.test.ts` looks like it should have caught this and could not:
 * it checks `<Link href>` APP ROUTES, never a path to a file on disk.
 *
 * WHAT THE BASELINE IS. The remaining entries name documents that were
 * DELETED, not moved — verified by following each one's rename chain through
 * git to a `docs/archive/` grave that D-110 then emptied. What is left is
 * overwhelmingly `docs/decisions/`, where "retiring `docs/launch/UAT_PRELAUNCH.md`"
 * is a TRUE statement about a deletion and repointing it would falsify the
 * record.
 *
 * The list is a RATCHET: an entry with no references left must be deleted from
 * it (the third test enforces that), so it can only shrink. Never add to it —
 * a new dangling path means a doc was moved or deleted without updating what
 * points at it, and the fix is to update the reference.
 */

/**
 * Generated per-language help articles — authored content, not references.
 */
const SKIP_PREFIXES = [
  "docs/help/",
  // THIS FILE. Its DELETED_DOCS list writes every path as a string literal,
  // so scanning itself made every entry look "still referenced" and the
  // ratchet below could never fire — it reported an empty unused set against a
  // list whose last real mention had already gone.
  "apps/web/tests/config/doc-paths.test.ts",
];

/** Only text we can plausibly read; skip images, fonts, archives, lockfiles. */
const TEXT_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|md|mdx|json|jsonc|ya?ml|toml|tf|tfvars|sh|env|sql|prisma|txt|example|hcl|Dockerfile)$/;
const BARE_TEXT_FILES = new Set([".gitignore", "Dockerfile", "requirements.txt", "Caddyfile"]);

/**
 * An absolute-from-root docs path. Stops at the extension so a possessive
 * ("…ORACLE_RUNNER.md's") or a sentence-ending period stays out of the match,
 * and refuses a leading path character so `apps/docs/x.md` is not mistaken for
 * a repo-root one.
 */
const DOC_PATH = /(?<![A-Za-z0-9_/.-])docs\/[A-Za-z0-9_/-]+\.[A-Za-z0-9]+/g;

/**
 * Paths that name a DELETED document. Each was chased through git: every one
 * was renamed into `docs/archive/` by the 2026-07-24 reorg and deleted with
 * that tree by D-110 (#803), or deleted outright by #1046 (a whole
 * workspace), #1090 (obsolete deployment runbooks) or #703 (the LiveKit box moving
 * to Tofu). None has a successor in the tree, so none can be repointed.
 *
 * Shrink this by rewriting the prose that mentions them. Do not grow it.
 */
const DELETED_DOCS = new Set([
  "docs/deployment/HETZNER_PLATFORM.md",
  "docs/deployment/ORACLE_RUNNER.md",
  "docs/deployment/SELF_HOSTED_RUNNER.md",
  "docs/engineering/DEVELOPMENT_WORKFLOW.md",
  "docs/engineering/ENTITLEMENTS_AUDIT.md",
  "docs/engineering/TECH_DEBT.md",
  "docs/engineering/integrations/whatsapp.md",
  "docs/engineering/lesson-insights.md",
  "docs/engineering/live-notes-panel.md",
  "docs/launch/UAT_PRELAUNCH.md",
  "docs/ops/FLY_SPIKE.md",
  "docs/ops/PREVIEW_DEPLOYMENTS.md",
  "docs/ops/PRODUCTION_CUTOVER.md",
  "docs/orientation/04-levels-and-materials.md",
  "docs/orientation/09-infrastructure-and-deployment.md",
  "docs/product/FINANCIAL_INTELLIGENCE.md",
  "docs/product/HOMEWORK_WORKFLOW.md",
  "docs/product/MATERIALS_TAXONOMY.md",
  "docs/product/SUBSCRIPTIONS.md",
  // Not a reference at all: a synthetic path fed to `changedTargets()` to
  // assert that a docs-only change is ignored by the relevance filter.
  "docs/x.md",
]);

/**
 * Paths a SCRIPT writes rather than a person. Absent from a fresh checkout
 * until someone runs the generator, so "it does not exist" is not evidence of
 * anything wrong — unlike every entry above, which names something gone.
 *
 * `docs/development/tested-behaviour.md` is `pnpm test:spec`'s output. Its path
 * has been wrong twice — it named `docs/engineering/` until 2026-09-06 and
 * `docs/testing/` until that directory folded into `docs/development/` — both
 * times because nothing in the gate calls the generator, so the broken output
 * path went unnoticed for weeks. An entry here is exempt from the
 * existence check, which is exactly why it cannot catch that.
 */
const GENERATED_DOCS = new Set(["docs/development/tested-behaviour.md"]);

function isTextFile(name: string): boolean {
  return TEXT_FILE.test(name) || BARE_TEXT_FILES.has(name);
}

/**
 * Every file in the tree, from `./_tree`, which skips whatever git ignores —
 * build output, dependencies, and other sessions' worktrees under
 * `.claude/worktrees/`, which this guard once read as if they were the tree and
 * reported offenders in files no edit to this checkout could fix (#1112).
 *
 * Deliberately NOT filtered to text: the set doubles as "does this path exist",
 * and a docs reference can legitimately name an image (the README's dashboard
 * screenshot) or any other binary.
 */
const walk = () => walkTree();

/** Every dangling docs path, mapped to the files that write it. */
function danglingReferences(): Map<string, string[]> {
  const present = new Set(walk().map((f) => relative(REPO_ROOT, f)));
  const dangling = new Map<string, string[]>();

  for (const file of present) {
    if (SKIP_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
    // Only read what we can plausibly parse; every file still counts as
    // EXISTING for the check above.
    if (!isTextFile(file.split("/").pop() ?? "")) continue;
    let source: string;
    try {
      source = readFileSync(join(REPO_ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(DOC_PATH)) {
      const path = match[0];
      // `present` is the walk's own view, so a path it contains exists.
      if (present.has(path)) continue;
      const seen = dangling.get(path) ?? [];
      if (!seen.includes(file)) seen.push(file);
      dangling.set(path, seen);
    }
  }
  return dangling;
}

describe("docs paths written in the repo", () => {
  const dangling = danglingReferences();

  it("walks enough of the tree to be checking anything", () => {
    // Guards the guard: a walk that returned nothing would pass every
    // assertion below having read not one file.
    expect(walk().length).toBeGreaterThan(1000);
  });

  it("names no docs file that does not exist", () => {
    const offenders = [...dangling]
      .filter(([path]) => !DELETED_DOCS.has(path) && !GENERATED_DOCS.has(path))
      .map(([path, files]) => `${path}\n    written by: ${files.join(", ")}`);

    expect(
      offenders,
      `These paths name a docs file that is not in the tree. A doc was moved or deleted ` +
        `without updating what points at it — repoint the reference at where the document ` +
        `lives now, or rewrite the sentence if it is gone. Do NOT add it to DELETED_DOCS:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("keeps DELETED_DOCS down to entries something still references", () => {
    // The ratchet. Once the last mention of a deleted document is rewritten,
    // its line here has to go too — otherwise the list becomes a graveyard
    // that outlives the problem and quietly permits the path to come back.
    const unused = [...DELETED_DOCS].filter((path) => !dangling.has(path)).sort();

    expect(
      unused,
      `Nothing references these any more. Delete them from DELETED_DOCS — the list only ` +
        `shrinks:\n${unused.join("\n")}`,
    ).toEqual([]);
  });
});
