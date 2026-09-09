import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

import { REPO_ROOT, walkTree } from "./_tree";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Every relative Markdown link resolves to a file that exists.
 *
 * WHY THIS EXISTS, given `doc-paths.test.ts` sits beside it. That one matches
 * `docs/…` paths written ANYWHERE — prose, code comments, YAML — and is
 * absolute-from-root by construction, so it cannot see `[setup](setup.md)`,
 * `[the gate](../../scripts/ci/gate.mjs)` or `[LICENSE](LICENSE)`. Those are
 * the links a reader actually clicks, and they are the ones a directory rename
 * breaks. `check-links.test.ts` does not help either: it checks `<Link href>`
 * APP ROUTES, never a path to a file on disk.
 *
 * Between them the three cover: routes the app serves, docs paths named in
 * prose, and links between files. Nothing had covered the last one, and the
 * 2026-09 documentation reorg is what surfaced it — renaming four files in
 * `docs/development/` left nine dead links that nothing failed on.
 *
 * WHAT IT DELIBERATELY IGNORES. External URLs, `mailto:`, pure `#anchor`
 * links, and targets that could not be a path in any tree — no slash, no
 * extension. That last exclusion is what lets a document print `![alt](src)` as
 * a piece of Markdown SYNTAX without the checker reading `src` as a file, and
 * three of them do.
 *
 * An anchor is checkable in principle and is not checked here: heading slugs
 * are renderer-specific (MkDocs Material, GitHub and Prettier's TOC all differ
 * on punctuation), so asserting them would encode one renderer's rules as the
 * truth and fail on a heading nobody broke.
 *
 * THERE IS NO EXCEPTION LIST, on purpose. A broken relative link has exactly
 * one honest fix — repoint it or remove it — so an allowlist would only ever
 * hold links somebody could not be bothered to fix.
 */

/**
 * `[text](target)`, optionally followed by a title. Reference-style links and
 * bare autolinks are not matched: neither can carry a relative file path in
 * this tree today, and matching them would drag in every `<https://…>`.
 */
const MARKDOWN_LINK = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Absolute, protocol-relative, in-page, or not a file path at all. */
const NOT_A_FILE_LINK = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|<|\{)/i;

/** A path names a directory or a file with an extension. `src` is neither. */
const LOOKS_LIKE_A_PATH = /[/.]/;

/**
 * Every Markdown file in the tree, from `./_tree`, which skips whatever git
 * ignores. That includes other sessions' worktrees under `.claude/worktrees/` —
 * whole copies of this repo, which this guard once read as if they were the
 * tree, reporting broken links in files no edit to this checkout could fix
 * (#1112).
 */
const markdownFiles = (dir: string = REPO_ROOT) => walkTree(dir, (name) => name.endsWith(".md"));

/**
 * MkDocs serves a directory through its `README.md`/`index.md`, and GitHub
 * renders a `.md` extension omitted from a link. Accept both so a link that
 * works in either reader counts as resolving.
 */
function resolves(target: string): boolean {
  return (
    existsSync(target) ||
    existsSync(`${target}.md`) ||
    existsSync(join(target, "README.md")) ||
    existsSync(join(target, "index.md"))
  );
}

function brokenLinks(): string[] {
  const broken: string[] = [];

  for (const file of markdownFiles(REPO_ROOT)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(MARKDOWN_LINK)) {
      const raw = match[1];
      if (NOT_A_FILE_LINK.test(raw)) continue;
      if (!LOOKS_LIKE_A_PATH.test(raw)) continue;
      // Strip a trailing anchor; the file has to exist either way.
      const target = raw.split("#")[0];
      if (!target) continue;
      if (resolves(resolve(dirname(file), target))) continue;
      broken.push(`${relative(REPO_ROOT, file)} → ${raw}`);
    }
  }

  return broken.sort();
}

describe("relative links between Markdown files", () => {
  it("reads enough Markdown to be checking anything", () => {
    // Guards the guard: an empty walk would pass the assertion below having
    // opened not one file.
    expect(markdownFiles(REPO_ROOT).length).toBeGreaterThan(100);
  });

  it("all resolve to a file in the tree", () => {
    const broken = brokenLinks();

    expect(
      broken,
      `These Markdown links point at nothing. Repoint each at where the file lives now, ` +
        `or remove the link if its target is gone — there is no exception list:\n` +
        broken.join("\n"),
    ).toEqual([]);
  });
});
