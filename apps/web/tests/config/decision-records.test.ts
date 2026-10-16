import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { REPO_ROOT, walkTree } from "./_tree";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Every `D-NN` written anywhere in the repo must name a decision record that
 * exists, and the log's index must list every record and only real ones.
 *
 * WHY THIS EXISTS. Decision records are cited from hundreds of files — schema
 * comments, route handlers, infra READMEs, runbooks, and each other — and the
 * citation is usually BARE prose (`// …one AI plumbing, two outputs (D-87)`)
 * rather than a markdown link. That matters because
 * `doc-paths.test.ts` already catches the LINK form, since
 * `[D-60](../../docs/decisions/D-60.md)` is a docs path like any other. It
 * cannot see `(D-60)`, and nothing else could either.
 *
 * The gap was not hypothetical. Two numbers were cited from nine code sites
 * for six weeks having never existed on `main` at all — the residue of a
 * numbering collision between branches. Then 42 records were curated out
 * before publication, which left 423 citations pointing at nothing until they
 * were swept by hand. A sweep with no guard behind it is a sweep that has to
 * be done again.
 *
 * LIVE AND RETIRED NUMBERS (D-202). The log was consolidated from 148 records
 * to one per live decision. A number is never reused, so every number that
 * stopped having a file is listed in the README's "Retired numbers" table with
 * where its reasoning went. Outside applied migrations a citation must name a
 * LIVE record — pointing a reader at a retired number sends them to a table
 * row instead of the reasoning. Inside migrations a retired number is allowed,
 * because those files cannot be edited (below) and the table resolves them.
 */

const DECISIONS_DIR = join(REPO_ROOT, "docs", "decisions");
const README = join(DECISIONS_DIR, "README.md");

/**
 * ⚠️ APPLIED MIGRATIONS ARE HELD TO A LOOSER RULE, and it is not an oversight.
 *
 * Prisma checksums every file under `prisma/migrations/`, so editing one — even
 * a comment — breaks `migrate deploy` against every database that already ran
 * it. A citation there can therefore never be repointed, which is why a number
 * cited by a migration may be retired but must stay in the Retired numbers
 * table forever: the table is the only thing that resolves it.
 */
const MIGRATIONS = "apps/web/prisma/migrations/";

/** THIS FILE writes `D-NN` tokens in prose to explain itself. */
const SKIP = new Set(["apps/web/tests/config/decision-records.test.ts"]);

/** Only text we can plausibly read; skips the visual-regression PNGs, whose
 *  bytes contain `D-` sequences by coincidence. */
const TEXT_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|md|mdx|json|jsonc|ya?ml|toml|tf|tftpl|tfvars|sh|env|sql|prisma|txt|example|hcl|Dockerfile)$/;
const BARE_TEXT_FILES = new Set([".gitignore", "Dockerfile", "Caddyfile"]);

/**
 * A decision citation. Bounded to three digits so `D-2026-06-11` (a date this
 * log writes) cannot match, and word-bounded on both sides so it does not fire
 * inside an identifier.
 */
const CITATION = /(?<![A-Za-z0-9_-])D-(\d{1,3})(?![0-9A-Za-z_-])/g;

/** `D-8` and `D-08` are the same record; the files are zero-padded to two. */
const norm = (n: string): number => Number.parseInt(n, 10);
const label = (n: number): string => `D-${String(n).padStart(2, "0")}`;

/**
 * The per-record ceiling (D-202). A record is one live decision, rewritten when
 * it changes; one that needs more than this is two decisions, or is carrying
 * history its How we got here should summarise. Aim for about 800.
 */
const MAX_RECORD_WORDS = 1500;

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

/** The README split around its "Retired numbers" section, which runs to the next `## `. */
function splitRetiredSection(readme: string): { section: string; rest: string } {
  const start = readme.indexOf("\n## Retired numbers\n");
  if (start === -1) return { section: "", rest: readme };
  const next = readme.indexOf("\n## ", start + 1);
  const end = next === -1 ? readme.length : next;
  return { section: readme.slice(start, end), rest: readme.slice(0, start) + readme.slice(end) };
}

type RetiredRow = { n: number; destination: string; line: string };

/** Rows of the Retired numbers table: `| D-NN | <where its reasoning went> |`, number in plain text. */
function retiredRows(): RetiredRow[] {
  const { section } = splitRetiredSection(readFileSync(README, "utf8"));
  return [...section.matchAll(/^\| D-(\d{1,3}) +\| (.*?) *\|$/gm)].map((m) => ({
    n: norm(m[1]),
    destination: m[2],
    line: m[0],
  }));
}

/** Every citation outside `allowed`, mapped to its writers. */
function badCitations(
  allowed: Set<number>,
  inScope: (file: string) => boolean,
): Map<number, string[]> {
  const bad = new Map<number, string[]>();

  for (const abs of walk()) {
    const file = relative(REPO_ROOT, abs);
    if (SKIP.has(file) || !inScope(file)) continue;
    if (!isTextFile(file.split("/").pop() ?? "")) continue;

    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    // The Retired numbers table is the one place outside a migration that
    // names a retired number — that is its whole job.
    if (abs === README) source = splitRetiredSection(source).rest;

    for (const match of source.matchAll(CITATION)) {
      const n = norm(match[1]);
      if (allowed.has(n)) continue;
      const seen = bad.get(n) ?? [];
      if (!seen.includes(file)) seen.push(file);
      bad.set(n, seen);
    }
  }
  return bad;
}

const report = (bad: Map<number, string[]>): string[] =>
  [...bad]
    .sort(([a], [b]) => a - b)
    .map(([n, files]) => `${label(n)}\n    cited by: ${files.join(", ")}`);

describe("decision records cited in the repo", () => {
  const records = existingRecords();
  const retired = retiredRows();
  const retiredNumbers = new Set(retired.map((r) => r.n));

  it("walks enough of the tree, and finds a plausible number of records", () => {
    // Guards the guard: a walk that returned nothing, a decisions directory
    // that failed to parse, or a table the parser no longer reads would pass
    // every assertion below having checked nothing at all. 148 records were
    // published before the consolidation, so live plus retired is at least that.
    expect(walk().length).toBeGreaterThan(1000);
    expect(records.size).toBeGreaterThan(10);
    expect(records.size + retiredNumbers.size).toBeGreaterThanOrEqual(148);
  });

  it("names only live decision records outside applied migrations", () => {
    const offenders = report(badCitations(records, (f) => !f.startsWith(MIGRATIONS)));

    expect(
      offenders,
      `These cite a decision record that is not in docs/decisions/. If the number is ` +
        `in the README's Retired numbers table, cite the record it points at, or state ` +
        `the fact the citation stood for. Otherwise the number is wrong. Do NOT create ` +
        `a stub record to satisfy this:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("names a live or a retired record inside applied migrations", () => {
    const known = new Set([...records, ...retiredNumbers]);
    const offenders = report(badCitations(known, (f) => f.startsWith(MIGRATIONS)));

    expect(
      offenders,
      `An applied migration cites a number that is neither a record nor in the ` +
        `Retired numbers table. The migration cannot be edited, so add the number ` +
        `to the table with where its reasoning went:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the Retired numbers table in agreement with the tree", () => {
    const problems: string[] = [];
    const seen = new Set<number>();

    for (const row of retired) {
      const id = label(row.n);
      if (seen.has(row.n)) problems.push(`${id} is in the table twice`);
      seen.add(row.n);
      if (records.has(row.n)) problems.push(`${id} is retired but ${id}.md still exists`);

      const dest = row.destination;
      const links = [...dest.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
      if (links.length === 0 && !/^retired: \S/.test(dest)) {
        problems.push(`${id} names neither a destination link nor "retired: <what it decided>"`);
      }
      for (const link of links) {
        const target = resolve(dirname(README), link.split("#")[0]);
        if (!existsSync(target)) problems.push(`${id} points at ${link}, which does not exist`);
      }
      for (const m of dest.matchAll(CITATION)) {
        if (!records.has(norm(m[1]))) {
          problems.push(`${id} points at ${label(norm(m[1]))}, which is not a live record`);
        }
      }
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("keeps every record under the word limit", () => {
    const over = [...records]
      .map((n) => {
        const text = readFileSync(join(DECISIONS_DIR, `${label(n)}.md`), "utf8");
        return { n, words: text.split(/\s+/).filter(Boolean).length };
      })
      .filter(({ words }) => words > MAX_RECORD_WORDS)
      .map(({ n, words }) => `${label(n)}: ${words} words`);

    expect(
      over,
      `A decision record is limited to ${MAX_RECORD_WORDS} words (D-202). Cut history ` +
        `the How we got here section does not need, or move behaviour to docs/features/:\n` +
        over.join("\n"),
    ).toEqual([]);
  });

  it("indexes every record, exactly once, in a theme table and in the numeric index", () => {
    // The index is the only way into the log, so a record missing from it is
    // a record nobody will read, and a row naming a deleted one is a 404.
    const readme = splitRetiredSection(readFileSync(README, "utf8")).rest;
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
