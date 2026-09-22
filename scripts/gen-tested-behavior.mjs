#!/usr/bin/env node
// Generate docs/development/tested-behaviour.md — a living, plain-language
// index of every behaviour the unit suites assert, built from the test
// names themselves via `vitest list`. It is a *product of the tests*, so it
// cannot drift the way a hand-written spec does: regenerate and the doc is
// exactly what the suite says today.
//
//   node scripts/gen-tested-behavior.mjs           # (re)write the doc
//   node scripts/gen-tested-behavior.mjs --check    # CI: fail if stale, write nothing
//
// Each workspace exposes its test tree through `vitest list`, which prints one
// line per leaf test as `[project] file > describe > ... > test name`. We parse
// those, rebuild the describe nesting, and render it as an indented Markdown
// outline.
//
// `--reporter=json` is deliberate: in plain `list` mode vitest's default
// reporter throws on a setup-file console.log during collection. The json
// reporter dodges that path while still emitting the text list.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// ⚠️ This path has been wrong twice, both times for the same reason: the
// generator's output lived in a directory a docs reorg moved, and nothing in
// the gate calls this script, so nobody found out. `docs/engineering/` was
// emptied in 2026-07 and `docs/testing/` folded into `docs/development/` in
// 2026-09. If you move it again, move this line in the same commit — the
// `doc-paths` guard lists this path as a GENERATED doc and will not catch it.
const OUT = path.join(repoRoot, "docs/development/tested-behaviour.md");

/** Apps to inventory, in doc order. Only the fast, no-DB unit tier — that is
 *  the suite that describes behaviour in plain names. Integration/E2E flows
 *  live in their own hand-written specs (tests/e2e, *.integration.test.ts). */
const APPS = [
  {
    title: "Web — apps/web",
    cwd: path.join(repoRoot, "apps/web"),
    args: ["vitest", "list", "--project", "unit", "--reporter=json"],
  },
];

/** Run `vitest list` for one app and return its raw `a > b > c` lines. */
function listTests(app) {
  const out = execFileSync("npx", app.args, {
    cwd: app.cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return (
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes(" > "))
      // Strip a leading `[project] ` tag (web has one, mobile doesn't).
      .map((l) => l.replace(/^\[[^\]]+\]\s+/, ""))
  );
}

/** Insert a `a > b > test` path into a nested tree keyed by file → describe…. */
function insert(tree, segments) {
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    (tree.tests ||= []).push(head);
    return;
  }
  const kids = (tree.children ||= new Map());
  if (!kids.has(head)) kids.set(head, {});
  insert(kids.get(head), rest);
}

/** Count leaf tests under a node (for the per-file/per-block tallies). */
function countTests(node) {
  let n = (node.tests || []).length;
  for (const child of (node.children || new Map()).values()) n += countTests(child);
  return n;
}

/** Render a describe node's children + tests as indented Markdown bullets. */
function renderNode(node, depth, lines) {
  const pad = "  ".repeat(depth);
  for (const [name, child] of (node.children || new Map()).entries()) {
    lines.push(`${pad}- **${name}** (${countTests(child)})`);
    renderNode(child, depth + 1, lines);
  }
  for (const test of node.tests || []) lines.push(`${pad}- ${test}`);
}

function buildDoc() {
  const lines = [];
  lines.push("# Tested behaviour");
  lines.push("");
  lines.push("**Generated file — do not edit by hand.** Regenerate with `pnpm test:spec`.");
  lines.push("");
  lines.push("A plain-language index of every behaviour the unit suites assert, built");
  lines.push("straight from the test names via `vitest list`. Because it is generated");
  lines.push("from the real suite it cannot drift — if a behaviour is listed here, a");
  lines.push("test asserts it today. This is the *what does the app do* view; the");
  lines.push("*what is not tested* view is the coverage report (`pnpm --filter");
  lines.push("spiralclass-web test:coverage`).");
  lines.push("");
  lines.push("Scope is the fast no-DB **unit** tier only. Real-DB integration flows");
  lines.push("(`*.integration.test.ts`) and the Playwright critical path (`tests/e2e`)");
  lines.push("carry their own hand-written specs.");
  lines.push("");

  let grandTotal = 0;
  const sections = [];

  for (const app of APPS) {
    const rawLines = listTests(app);
    // tree: Map<file, node>
    const files = new Map();
    for (const raw of rawLines) {
      const segments = raw.split(" > ");
      const file = segments[0];
      if (!files.has(file)) files.set(file, {});
      insert(files.get(file), segments.slice(1));
    }

    const appTotal = [...files.values()].reduce((n, f) => n + countTests(f), 0);
    grandTotal += appTotal;

    const body = [];
    body.push(`## ${app.title}`);
    body.push("");
    body.push(`${appTotal} assertions across ${files.size} files.`);
    body.push("");
    for (const file of [...files.keys()].sort()) {
      const node = files.get(file);
      body.push(`### \`${file}\` (${countTests(node)})`);
      body.push("");
      const bullets = [];
      renderNode(node, 0, bullets);
      body.push(...bullets);
      body.push("");
    }
    sections.push(body.join("\n"));
  }

  // Summary line goes right under the intro, once we know the totals.
  lines.push(`> ${grandTotal} behaviours indexed across ${APPS.length} apps.`);
  lines.push("");
  lines.push("---");
  lines.push("");

  return lines.join("\n") + sections.join("\n") + "\n";
}

const doc = buildDoc();
const check = process.argv.includes("--check");

if (check) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    /* missing file → stale */
  }
  if (current !== doc) {
    console.error("tested-behaviour.md is stale. Run `pnpm test:spec` and commit the result.");
    process.exit(1);
  }
  console.log("tested-behaviour.md is up to date.");
} else {
  writeFileSync(OUT, doc);
  console.log(`Wrote ${path.relative(repoRoot, OUT)}`);
}
