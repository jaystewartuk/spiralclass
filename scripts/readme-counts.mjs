#!/usr/bin/env node
// Every count stated in the front-door documents, recomputed from the tree and
// compared to what those documents say.
//
// Why this exists: on 2026-09-04 a cold read of the README — the first thing a
// stranger sees now the repository is public — found six numbers wrong at once.
// A whole workspace had been deleted that morning and the test-file
// count went with it; migrations, indexes, background functions and the
// decision-record count had each drifted on their own. Nothing checked any of
// them, because they were typed by hand and a sentence cannot fail a build.
//
// The rule this enforces is the repository's own: a number in prose is a claim,
// and a claim nothing verifies is a claim that is eventually false.
//
// ⚠️ It reads SEVERAL files, not just the README, and that is deliberate. The
// first version checked README.md alone, which made moving a sentence into a
// deeper document a silent way to stop checking it — exactly the drift this
// exists to prevent, achieved by a refactor rather than a typo. `CHECKED` below
// is the set of documents whose numbers are held to the tree; a claim must be
// stated in at least one of them.
//
//   node scripts/readme-counts.mjs          check, exit 1 on any drift
//   node scripts/readme-counts.mjs --fix    rewrite the files to the real values
//
// Adding a number to one of those documents means adding it here. That is the
// cost, and it is the point: a count nobody was willing to make checkable does
// not belong in a document whose whole claim is that nothing was staged for
// presentation.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = resolve(ROOT, "apps/web/prisma/schema.prisma");
const ENV_EXAMPLE = resolve(ROOT, "apps/web/.env.example");

/**
 * The documents whose numbers are checked. Order is the order a reader meets
 * them; a claim may be stated in any of them, or in several.
 */
const CHECKED = [
  "README.md",
  // ⚠️ Added 2026-09-06. The docs front door stated the decision-record count
  // and was not checked, which is the exact drift this file's header warns
  // about — a claim moved into a deeper document is a claim that silently
  // stopped being verified. It said 166 against a tree with 125.
  //
  // `docs/decisions/README.md` is deliberately NOT here, and the reason is
  // worth knowing before somebody adds it: a decision log states numbers ABOUT
  // THE PAST on purpose. Two of its rows say "125 migrations squashed to one
  // baseline" (D-70) and "46 migrations become two" (D-168), both true, both
  // about a tree that no longer exists. Holding a history-bearing document to
  // the present tree is a category error, so its own heading states no count at
  // all — the index below it lists every record, and
  // `tests/config/decision-records.test.ts` already proves that list is
  // complete and contains only real ones. A count there would be redundant AND
  // unverified, which is the worst of both.
  "docs/README.md",
  "docs/architecture/overview.md",
  "docs/architecture/data-model.md",
  "docs/development/setup.md",
  "docs/development/testing.md",
  // ⚠️ Added 2026-09-08 with the file itself. `docs/decisions/README.md` is
  // deliberately excluded above because a decision log states numbers ABOUT THE
  // PAST on purpose — and READ-THIS-FIRST.md does too, quoting 220 routes and
  // eleven days from records that describe a tree which no longer exists. It is
  // here for the ONE present-tense claim it makes, "N decision records in this
  // directory", which is a statement about the tree as it stands today.
  //
  // That is also the constraint on editing it: a number in that file which
  // describes the past must not be phrased so a pattern here can match it. It
  // says "40 files ... of tests" rather than "40 test files" for exactly that
  // reason — the latter would be rewritten to the whole tree's count.
  "docs/decisions/READ-THIS-FIRST.md",
];

const git = (...args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);

const tracked = (...pathspec) => git("ls-files", ...pathspec).length;
const schema = () => readFileSync(SCHEMA, "utf8");
const occurrences = (text, needle) => text.split(needle).length - 1;

/** Distinct `KEY=` declarations in the documented env template. */
const envVars = () =>
  new Set(readFileSync(ENV_EXAMPLE, "utf8").match(/^[A-Z][A-Z0-9_]*(?==)/gm) ?? []).size;

/**
 * Each claim names what it counts, how to count it, and the shape it takes in
 * the README. `pattern` must capture the number in group 1 and match every
 * place the claim is stated — a count that appears twice drifts in one of them.
 *
 * @typedef {Object} Claim
 * @property {string}   id
 * @property {() => number} actual
 * @property {RegExp}   pattern   global, group 1 is the number
 */

/** @type {Claim[]} */
const CLAIMS = [
  {
    id: "route handlers",
    actual: () => tracked("apps/web/src/app/**/route.ts"),
    pattern: /(\d[\d,]*) route handlers/g,
  },
  // The "N of them /api/mobile/*" claim retired with the tree it counted
  // Left as a note rather than silently dropped: this file's own rule is that
  // a claim counted but stated nowhere is an error, and that rule is what
  // surfaced this one the moment those routes went.
  {
    id: "decision records",
    actual: () => tracked("docs/decisions/D-*.md"),
    pattern: /(\d[\d,]*) decision records/g,
  },
  {
    id: "server-action modules",
    actual: () => tracked("apps/web/src/app/actions/*"),
    pattern: /(\d[\d,]*) server-action modules/g,
  },
  {
    id: "Prisma models",
    actual: () => occurrences(schema(), "\nmodel "),
    pattern: /(\d[\d,]*) models/g,
  },
  {
    id: "migrations",
    actual: () =>
      readdirSync(resolve(ROOT, "apps/web/prisma/migrations"), {
        withFileTypes: true,
      }).filter((e) => e.isDirectory()).length,
    pattern: /(\d[\d,]*) migrations/g,
  },
  {
    id: "indexes",
    actual: () => occurrences(schema(), "@@index"),
    pattern: /(\d[\d,]*) indexes/g,
  },
  {
    id: "unique constraints",
    actual: () => occurrences(schema(), "@@unique"),
    pattern: /(\d[\d,]*) unique constraints/g,
  },
  {
    id: "Inngest background functions",
    actual: () => git("grep", "-ho", "inngest.createFunction", "--", "apps/web/src").length,
    pattern: /(\d[\d,]*) background functions/g,
  },
  {
    id: "test files",
    actual: () => git("ls-files").filter((f) => /\.(test|spec)\.[tj]sx?$/.test(f)).length,
    pattern: /(\d[\d,]*) test files/g,
  },
  {
    // Stated in the setup guide as "all N variables are documented there".
    // It read 93 for long enough that nobody could say when it stopped being
    // true; the file had 141.
    id: "documented environment variables",
    actual: envVars,
    pattern: /[Aa]ll (\d[\d,]*) variables/g,
  },
  {
    id: "integration suites",
    actual: () => git("ls-files").filter((f) => /\.integration\.test\.ts$/.test(f)).length,
    pattern: /(\d[\d,]*) suites against a real Postgres/g,
  },
  {
    // The number of claims in this array, stated in the README's own sentence
    // about this file. It said "eleven" — spelled as a word, which is exactly
    // why nothing caught it when a twelfth landed. A checker that cannot count
    // itself is the one claim in the front door with no mechanism behind it.
    id: "checked claims",
    actual: () => CLAIMS.length,
    pattern: /(\d[\d,]*) checked claims/g,
  },
  {
    // Distinct ROUTES under the visual baselines, not files: each route is
    // captured at six widths in two themes, so the 120 committed PNGs are 10
    // surfaces. (240 until [D-171] deleted the second platform's set.) Counting
    // files would state a number twelve times larger than the thing the
    // sentence is about, and it would move when a breakpoint was added rather
    // than when a page was.
    id: "public surfaces with a visual baseline",
    actual: () =>
      new Set(
        git("ls-files", "apps/web/tests/visual/regression.spec.ts-snapshots").map((f) =>
          f.replace(/^.*\//, "").replace(/-\d+-(light|dark)-linux\.png$/, ""),
        ),
      ).size,
    pattern: /(\d[\d,]*) public surfaces held to committed visual baselines/g,
  },
];

const fix = process.argv.includes("--fix");
/** @type {Map<string, string>} relative path -> current contents */
const docs = new Map(CHECKED.map((rel) => [rel, readFileSync(resolve(ROOT, rel), "utf8")]));
const dirty = new Set();
const drift = [];
const unstated = [];

for (const claim of CLAIMS) {
  const actual = claim.actual();
  let stated = 0;

  for (const [rel, text] of docs) {
    const matches = [...text.matchAll(claim.pattern)];
    if (matches.length === 0) continue;
    stated += matches.length;

    let next = text;
    for (const m of matches) {
      if (Number(m[1].replace(/,/g, "")) === actual) continue;
      drift.push(`${claim.id}: ${rel} says ${m[1]}, the tree says ${actual}`);
      if (fix) next = next.replace(m[0], m[0].replace(m[1], String(actual)));
    }
    if (next !== text) {
      docs.set(rel, next);
      dirty.add(rel);
    }
  }

  if (stated === 0) {
    unstated.push(`${claim.id} (${actual}) — no sentence in the checked documents states it`);
  }
}

if (unstated.length > 0) {
  console.error(
    "Counted, but claimed nowhere — remove it here, or state it in one of:\n  " +
      CHECKED.join("\n  "),
  );
  for (const line of unstated) console.error(`  · ${line}`);
}

if (drift.length === 0 && unstated.length === 0) {
  console.log(
    `Doc counts: ${CLAIMS.length} claims across ${CHECKED.length} documents, all match the tree.`,
  );
  process.exit(0);
}

if (fix && drift.length > 0) {
  for (const rel of dirty) writeFileSync(resolve(ROOT, rel), docs.get(rel));
  console.log(`Rewrote ${dirty.size} file(s) — ${drift.length} count(s) corrected:`);
  for (const line of drift) console.log(`  · ${line}`);
  process.exit(unstated.length > 0 ? 1 : 0);
}

if (drift.length > 0) {
  console.error("::error::The documentation states counts the tree does not support.");
  for (const line of drift) console.error(`  · ${line}`);
  console.error("\nRun `node scripts/readme-counts.mjs --fix` and commit the result.");
}

process.exit(1);
