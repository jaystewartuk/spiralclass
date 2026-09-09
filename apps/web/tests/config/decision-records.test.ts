import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

import { REPO_ROOT, walkTree } from "./_tree";
import { join, relative } from "node:path";

/**
 * Every `D-NN` written anywhere in the repo must name a decision record that
 * exists, and the log's index must list every record and only real ones.
 *
 * WHY THIS EXISTS. Decision records are cited from ~130 files — schema
 * comments, route handlers, infra READMEs, runbooks, and each other — and the
 * citation is usually BARE prose (`// …one AI plumbing, two outputs (D-69)`)
 * rather than a markdown link. That matters because
 * `doc-paths.test.ts` already catches the LINK form, since
 * `[D-60](../../docs/decisions/D-60.md)` is a docs path like any other. It
 * cannot see `(D-60)`, and nothing else could either.
 *
 * The gap was not hypothetical. Two numbers were cited from nine code sites
 * for six weeks having never existed on `main` at all — the residue of a
 * numbering collision between branches, which
 * [D-72](../../../../docs/decisions/D-72.md) noticed, wrote down as
 * "worth backfilling", and nobody backfilled. Then 42 records were curated out
 * before publication, which left 423 citations pointing at nothing until they
 * were swept by hand. A sweep with no guard behind it is a sweep that has to
 * be done again.
 *
 * This is the same failure the log keeps recording about itself: a reference
 * that rots silently costs more than one that breaks loudly, because the
 * reader who follows it has no way to tell a wrong pointer from a missing
 * document. D-110 counted ~440 of them from one reorganisation.
 */

const DECISIONS_DIR = join(REPO_ROOT, "docs", "decisions");

/**
 * ⚠️ APPLIED MIGRATIONS ARE EXCLUDED, and it is not an oversight.
 *
 * Prisma checksums every file under `prisma/migrations/`, so editing one — even
 * a comment — breaks `migrate deploy` against every database that already ran
 * it. CLAUDE.md sanctions leaving a stale reference there for exactly this
 * reason. The consequence is real and worth knowing: a record cited only by a
 * migration can never be curated out without leaving a dangling citation
 * nothing can repair, so `D-83` and `D-93` were kept for that reason alone.
 */
const SKIP_PREFIXES = [
  "apps/web/prisma/migrations/",
  // THIS FILE. It writes `D-NN` tokens in prose to explain itself.
  "apps/web/tests/config/decision-records.test.ts",
];

/** Only text we can plausibly read; skips the visual-regression PNGs, whose
 *  bytes contain `D-` sequences by coincidence. */
const TEXT_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|md|mdx|json|jsonc|ya?ml|toml|tf|tftpl|tfvars|sh|env|sql|prisma|txt|example|hcl|Dockerfile)$/;
const BARE_TEXT_FILES = new Set([".gitignore", "Dockerfile", "requirements.txt", "Caddyfile"]);

/**
 * A decision citation. Bounded to three digits so `D-2026-06-11` (a date this
 * log writes) cannot match, and word-bounded on both sides so it does not fire
 * inside an identifier.
 */
const CITATION = /(?<![A-Za-z0-9_-])D-(\d{1,3})(?![0-9A-Za-z_-])/g;

/** `D-8` and `D-08` are the same record; the files are zero-padded to two. */
const norm = (n: string): number => Number.parseInt(n, 10);

function isTextFile(name: string): boolean {
  return TEXT_FILE.test(name) || BARE_TEXT_FILES.has(name);
}

/**
 * Every file in the tree, from `./_tree`, which skips whatever git ignores.
 * That includes other sessions' worktrees under `.claude/worktrees/` — whole
 * copies of this repo, which this guard once read as if they were the tree,
 * reporting offenders in files no edit to this checkout could fix (#1112).
 */
const walk = () => walkTree();

/** The records that actually exist, by number. */
function existingRecords(): Set<number> {
  return new Set(
    readdirSync(DECISIONS_DIR)
      .map((f) => /^D-(\d{1,3})\.md$/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => norm(m[1])),
  );
}

/** Every citation of a record that does not exist, mapped to its writers. */
function danglingCitations(records: Set<number>): Map<number, string[]> {
  const dangling = new Map<number, string[]>();

  for (const abs of walk()) {
    const file = relative(REPO_ROOT, abs);
    if (SKIP_PREFIXES.some((p) => file.startsWith(p))) continue;
    if (!isTextFile(file.split("/").pop() ?? "")) continue;

    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }

    for (const match of source.matchAll(CITATION)) {
      const n = norm(match[1]);
      if (records.has(n)) continue;
      const seen = dangling.get(n) ?? [];
      if (!seen.includes(file)) seen.push(file);
      dangling.set(n, seen);
    }
  }
  return dangling;
}

describe("decision records cited in the repo", () => {
  const records = existingRecords();

  it("walks enough of the tree, and finds a plausible number of records", () => {
    // Guards the guard: a walk that returned nothing, or a decisions directory
    // that failed to parse, would pass every assertion below having checked
    // nothing at all.
    expect(walk().length).toBeGreaterThan(1000);
    expect(records.size).toBeGreaterThan(50);
  });

  it("names no decision record that does not exist", () => {
    const offenders = [...danglingCitations(records)]
      .sort(([a], [b]) => a - b)
      .map(([n, files]) => `D-${String(n).padStart(2, "0")}\n    cited by: ${files.join(", ")}`);

    expect(
      offenders,
      `These cite a decision record that is not in docs/decisions/. Either the ` +
        `record was curated out before publication — in which case rewrite the sentence ` +
        `to state the fact rather than cite nothing — or the number is wrong. Do NOT ` +
        `create a stub record to satisfy this:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("indexes every record, exactly once, in a theme table and in the numeric index", () => {
    // The index is the only way into 124 files, so a record missing from it is
    // a record nobody will read, and a row naming a deleted one is a 404.
    const readme = readFileSync(join(DECISIONS_DIR, "README.md"), "utf8");
    const [themes, numeric] = readme.split("## Every record, by number");
    expect(numeric, "the index lost its 'Every record, by number' section").toBeDefined();

    const rowsIn = (section: string): number[] =>
      [...section.matchAll(/^\| \[D-(\d{1,3})\]/gm)].map((m) => norm(m[1]));

    const themeRows = rowsIn(themes);
    const numericRows = rowsIn(numeric);
    const sorted = (ns: Iterable<number>) => [...ns].sort((a, b) => a - b);

    expect(sorted(numericRows), "the numeric index and the tree disagree").toEqual(sorted(records));
    expect(sorted(themeRows), "a record is in no theme table, or in one twice").toEqual(
      sorted(records),
    );
  });
});
