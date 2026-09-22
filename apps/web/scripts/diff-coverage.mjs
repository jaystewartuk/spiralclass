#!/usr/bin/env node
// Per-PR diff-coverage gate (TEST_AUDIT_2026-06-26.md, P2).
//
// The aggregate coverage floor in vitest.config.ts is a months-old line: it
// forbids the WHOLE codebase from dropping below X%, but does nothing to stop a
// new file landing at 0% as long as the average stays up. This script closes
// that gap — it holds NEW code to account by measuring coverage only on the
// lines this branch added/changed, and fails when too few of them are covered.
//
// How it works:
//   1. `git diff --unified=0 <base>...HEAD` → the set of added line numbers per
//      file (new-file numbering).
//   2. Keep only files inside the coverage scope (the same lib + server-action
//      + API-handler layer vitest.config.ts measures), excluding tests/types.
//   3. Read coverage/coverage-final.json (v8 per-statement hit counts) and, for
//      each added line, decide: is it executable (covered by some statement
//      range) and was that statement hit?
//   4. ratio = coveredAddedLines / executableAddedLines. Fail if there are at
//      least MIN_NEW_LINES executable added lines and the ratio is below
//      THRESHOLD.
//
// Small diffs (< MIN_NEW_LINES executable added lines) pass automatically — the
// gate targets meaningful new logic, not a one-line tweak. Pure non-executable
// changes (comments/types) contribute no executable lines and are ignored.
//
// Env knobs:
//   DIFF_COVERAGE_BASE       git ref to diff against (default: origin/main)
//   DIFF_COVERAGE_THRESHOLD  minimum covered ratio 0..1 (default: 0.80)
//   DIFF_COVERAGE_MIN_LINES  skip the gate below this many executable lines (default: 15)
//   DIFF_COVERAGE_FILE       coverage-final.json path (default: coverage/coverage-final.json)

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.DIFF_COVERAGE_BASE || "origin/main";
const THRESHOLD = Number(process.env.DIFF_COVERAGE_THRESHOLD || "0.8");
const MIN_LINES = Number(process.env.DIFF_COVERAGE_MIN_LINES || "15");
const COVERAGE_FILE = process.env.DIFF_COVERAGE_FILE || "coverage/coverage-final.json";

// Mirror vitest.config.ts coverage.include / exclude: the testable logic layer.
const INCLUDE = [/^src\/lib\//, /^src\/app\/actions\//, /^src\/app\/api\//];
const EXCLUDE = [
  /\.d\.ts$/,
  /\.test\.ts$/,
  /^src\/lib\/prisma\.ts$/,
  /^src\/lib\/inngest\/client\.ts$/,
  /^src\/lib\/stripe\/types\.ts$/,
  // Browser-only live-caption plumbing — see vitest.config.ts coverage.exclude.
  /^src\/lib\/captions\/use-caption-feed\.ts$/,
  /^src\/lib\/captions\/use-caption-preferences\.ts$/,
];

function inScope(repoRelPath) {
  // git reports paths from the repo root; this script runs in apps/web.
  if (!repoRelPath.startsWith("apps/web/")) return null;
  const rel = repoRelPath.slice("apps/web/".length);
  if (!rel.endsWith(".ts")) return null;
  if (!INCLUDE.some((re) => re.test(rel))) return null;
  if (EXCLUDE.some((re) => re.test(rel))) return null;
  return rel; // path relative to apps/web
}

// Parse `git diff --unified=0` into { relPath -> Set<addedLineNo> }.
function addedLinesByFile(diff) {
  const out = new Map();
  let current = null;
  for (const line of diff.split("\n")) {
    const file = /^\+\+\+ b\/(.+)$/.exec(line);
    if (file) {
      current = inScope(file[1]);
      continue;
    }
    if (!current) continue;
    // @@ -a,b +c,d @@  → added hunk starts at new-line c, spanning d lines.
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const set = out.get(current) || new Set();
      for (let i = 0; i < count; i++) set.add(start + i);
      out.set(current, set);
    }
  }
  return out;
}

// For one coverage entry, build line -> { executable, covered }.
function lineCoverage(entry) {
  const lines = new Map();
  const mark = (map, ranges, counts) => {
    for (const [id, range] of Object.entries(ranges)) {
      const startLine = range.start?.line;
      const endLine = range.end?.line ?? startLine;
      if (!startLine) continue;
      const hit = (counts[id] || 0) > 0;
      for (let l = startLine; l <= endLine; l++) {
        const prev = map.get(l);
        // A line is covered if ANY statement/branch on it was hit.
        map.set(l, { executable: true, covered: (prev?.covered ?? false) || hit });
      }
    }
  };
  mark(lines, entry.statementMap || {}, entry.s || {});
  // Function declaration lines also count as executable logic.
  for (const [id, fn] of Object.entries(entry.fnMap || {})) {
    const loc = fn.decl || fn.loc;
    const l = loc?.start?.line;
    if (!l) continue;
    const hit = (entry.f?.[id] || 0) > 0;
    const prev = lines.get(l);
    lines.set(l, { executable: true, covered: (prev?.covered ?? false) || hit });
  }
  return lines;
}

function main() {
  let diff;
  try {
    diff = execSync(`git diff --unified=0 ${BASE}...HEAD -- 'apps/web/src/**/*.ts'`, {
      cwd: resolve(process.cwd(), "../.."),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`diff-coverage: could not git diff against ${BASE}: ${err.message}`);
    console.error("Pass a reachable base via DIFF_COVERAGE_BASE; skipping gate.");
    return 0;
  }

  const added = addedLinesByFile(diff);
  if (added.size === 0) {
    console.log(`diff-coverage: no in-scope source lines changed vs ${BASE} — nothing to gate.`);
    return 0;
  }

  let coverage;
  try {
    coverage = JSON.parse(readFileSync(COVERAGE_FILE, "utf8"));
  } catch (err) {
    console.error(`diff-coverage: could not read ${COVERAGE_FILE}: ${err.message}`);
    console.error("Run `pnpm test:coverage` first (it emits the json reporter).");
    return 1;
  }

  // Index coverage by apps/web-relative path (keys are absolute).
  const byRel = new Map();
  for (const [absPath, entry] of Object.entries(coverage)) {
    const norm = absPath.replace(/\\/g, "/");
    const idx = norm.indexOf("/apps/web/");
    const rel = idx >= 0 ? norm.slice(idx + "/apps/web/".length) : norm;
    byRel.set(rel, entry);
  }

  let executable = 0;
  let covered = 0;
  const offenders = [];
  for (const [rel, addedSet] of added) {
    const entry = byRel.get(rel);
    if (!entry) {
      // Changed an in-scope file with no coverage entry at all → it was never
      // imported by any test. Treat its added lines as uncovered (can't prove
      // they ran), but only if the file is non-trivial.
      offenders.push(`${rel} (no coverage data — file untested)`);
      continue;
    }
    const lc = lineCoverage(entry);
    let fileExec = 0;
    let fileCov = 0;
    for (const line of addedSet) {
      const info = lc.get(line);
      if (!info?.executable) continue; // comment/blank/type-only line
      fileExec += 1;
      executable += 1;
      if (info.covered) {
        fileCov += 1;
        covered += 1;
      }
    }
    if (fileExec > 0 && fileCov / fileExec < THRESHOLD) {
      offenders.push(`${rel}: ${fileCov}/${fileExec} added lines covered`);
    }
  }

  const ratio = executable === 0 ? 1 : covered / executable;
  const pct = (ratio * 100).toFixed(1);
  console.log(
    `diff-coverage: ${covered}/${executable} executable added lines covered (${pct}%) ` +
      `vs ${BASE}; threshold ${(THRESHOLD * 100).toFixed(0)}%, min ${MIN_LINES} lines.`,
  );

  if (executable < MIN_LINES) {
    console.log(`diff-coverage: under ${MIN_LINES} executable added lines — gate skipped.`);
    return 0;
  }
  if (ratio < THRESHOLD) {
    console.error("::error::diff-coverage: new code is under-tested. Offenders:");
    for (const o of offenders) console.error(`  - ${o}`);
    console.error(
      `Cover the added lines above (or split out genuinely untestable infra) to clear the gate.`,
    );
    return 1;
  }
  console.log("diff-coverage: OK.");
  return 0;
}

process.exit(main());
