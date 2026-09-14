#!/usr/bin/env node
/**
 * Check an issue draft before it is published, and audit the ones already open.
 *
 * WHY THIS EXISTS. D-172 moved open work into this repository's Issues and
 * recorded, as an unresolved risk, that "nothing enforces the issue shape … a
 * drift check is possible and is not built". The /issue skill is a checklist;
 * this is the part of the checklist a machine does better than a model:
 *
 *   SHAPE     — a title that is a sentence rather than a category prefix or an
 *               imperative, and a **Done when** line a pull request can meet.
 *   LABELS    — every label exists (gh issue create fails outright otherwise),
 *               and at most one priority.
 *   LEAKS     — the same detectors the gate runs over the tree
 *               (scripts/check-leaks.mjs): credentials, account identifiers,
 *               undeclared person names and personal email addresses. The
 *               repository is public, so filing publishes, and an issue body is
 *               where a pasted log or a student's message ends up.
 *   DUPLICATES — the closest existing issues, open AND closed, by shared words
 *               and shared file paths. A ranking to read, never a verdict: it
 *               cannot tell "the same work" from "the same file".
 *
 * It never writes to GitHub. Filing, commenting and closing stay with the
 * session and the user.
 *
 * Usage:
 *   node scripts/issue-check.mjs --title "<title>" --body-file <path> [--label x]...
 *   node scripts/issue-check.mjs --audit        # every open issue, shape only
 *
 * Exit 1 when anything is an error. Warnings print and do not fail.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findIdentifiers, findPeople, findPersonalData, findSecrets } from "./check-leaks.mjs";

/** The priorities D-172's weekly triage sets. */
export const PRIORITY_LABELS = ["p1", "p2", "p3"];

/** Labels that say what kind of work an issue is. */
export const TYPE_LABELS = ["bug", "enhancement", "documentation", "ci", "accessibility"];

/**
 * Verbs an imperative title starts with. A title here names the problem from
 * the user's side ("A forgotten tenant filter still returns every teacher's
 * rows"), not the task ("Fix tenant filter") — the task is the PR's to name.
 */
const IMPERATIVE_OPENERS = new Set(
  (
    "add fix update remove delete refactor implement investigate improve support " +
    "create make use move rename migrate replace clean cleanup bump upgrade " +
    "document write build enable disable allow handle ensure check consider " +
    "change set convert extract introduce drop revert test"
  ).split(" "),
);

/** `feat: x`, `ci(web): x`, `fix!: x`, `[bug] x`. */
const CATEGORY_PREFIX = /^(?:[A-Za-z-]+(?:\([^)]*\))?!?:\s|\[[^\]]+\]\s*)/;

/**
 * The end state, in either form the tracker already uses: a bold **Done when**
 * line, or a `## What done looks like` / `## Done when` section for work that
 * needs more than a line (#90–#96 are written that way).
 */
const DONE_WHEN = /\*\*Done when\*\*|^#{2,4}\s+(?:What done looks like|Done when)\b/im;

/**
 * Lint one issue — a draft, or an existing issue in audit mode.
 *
 * @param {{ title: string, body: string, labels?: string[] }} issue
 * @param {{ knownLabels?: Iterable<string>, scanLeaks?: boolean }} [options]
 *   `knownLabels` omitted skips the existence check (no `gh` available).
 */
export function lintIssue(issue, options = {}) {
  const { title, body } = issue;
  const labels = issue.labels ?? [];
  const errors = [];
  const warnings = [];

  const trimmed = title.trim();
  if (CATEGORY_PREFIX.test(trimmed)) {
    errors.push(
      "title starts with a category prefix — write a sentence naming the problem instead",
    );
  }
  const firstWord = trimmed.replace(CATEGORY_PREFIX, "").split(/\s+/)[0]?.toLowerCase() ?? "";
  if (IMPERATIVE_OPENERS.has(firstWord)) {
    errors.push(
      `title is an instruction ("${firstWord} …") — name the problem from the user's side; the PR names the task`,
    );
  }
  if (trimmed.split(/\s+/).length < 6) {
    errors.push("title is too short to be a sentence naming the problem");
  }
  if (/[.!]$/.test(trimmed)) {
    warnings.push("title ends in punctuation — the house style does not");
  }

  if (!DONE_WHEN.test(body)) {
    errors.push("body has no **Done when** line — without one no pull request can close it");
  }

  if (options.knownLabels) {
    const known = new Set(options.knownLabels);
    for (const label of labels) {
      if (!known.has(label)) errors.push(`label "${label}" does not exist on the repository`);
    }
  }
  const priorities = labels.filter((l) => PRIORITY_LABELS.includes(l));
  if (priorities.length > 1) {
    errors.push(`more than one priority label: ${priorities.join(", ")}`);
  } else if (priorities.length === 0) {
    warnings.push("no priority label — say why, and the weekly triage will set one");
  }
  if (!labels.some((l) => TYPE_LABELS.includes(l))) {
    warnings.push(`no type label (${TYPE_LABELS.join(", ")})`);
  }

  if (options.scanLeaks !== false) {
    // Only the kind is reported, never the matched text: this output lands in a
    // transcript, and repeating a secret is how it spreads.
    const text = `${title}\n\n${body}`;
    const file = "issue-draft.md";
    for (const { kind } of findSecrets(file, text)) {
      errors.push(`possible credential (${kind}) — remove it; if it is live, rotate it`);
    }
    for (const { kind } of findIdentifiers(file, text)) {
      errors.push(`account identifier (${kind}) — this repository is public; use a placeholder`);
    }
    for (const { name } of findPeople(file, text)) {
      errors.push(
        `undeclared person name "${name}" — describe the shape of the problem, not the person`,
      );
    }
    if (findPersonalData(text).length > 0) {
      errors.push("a personal email address — remove it");
    }
  }

  return { errors, warnings };
}

/* ------------------------------------------------------------------ *
 * Duplicates
 * ------------------------------------------------------------------ */

const STOPWORDS = new Set(
  (
    "the and for that this with from are was were been has have had not but its into " +
    "than then when what which who why how there their they them does did doing done " +
    "can could would should will still every only also just more most some any all " +
    "one two nothing anything something because before after about over under each " +
    "where while being same other own out off our you your her his she him"
  ).split(" "),
);

/** Lower-case content words of three letters or more. */
export function tokens(text) {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter((w) => !STOPWORDS.has(w)),
  );
}

/** Repo-relative paths named in backticks — the strongest sign of the same area. */
export function pathsIn(text) {
  return new Set([...text.matchAll(/`([^`\s]+\/[^`\s]+)`/g)].map((m) => m[1].replace(/:\d+$/, "")));
}

const jaccard = (a, b) => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared += 1;
  return shared / (a.size + b.size - shared);
};

/** The share of `a` that also appears in `b`. */
const coverage = (a, b) => {
  if (a.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared += 1;
  return shared / a.size;
};

/**
 * Rank existing issues by likeness to a draft.
 *
 * Title-to-title overlap carries the most weight; how much of the draft's
 * title the other issue's body covers catches a duplicate worded differently;
 * a shared file path adds a fixed bonus.
 *
 * @param {{ title: string, body: string }} draft
 * @param {Array<{ number: number, title: string, body?: string, state: string, stateReason?: string }>} issues
 */
export function similarIssues(draft, issues, { limit = 5, threshold = 0.2 } = {}) {
  const draftTitle = tokens(draft.title);
  const draftPaths = pathsIn(draft.body);

  return issues
    .map((issue) => {
      const otherAll = tokens(`${issue.title}\n${issue.body ?? ""}`);
      const sharedPaths = [...pathsIn(issue.body ?? "")].filter((p) => draftPaths.has(p));
      const score =
        0.6 * jaccard(draftTitle, tokens(issue.title)) +
        0.4 * coverage(draftTitle, otherAll) +
        (sharedPaths.length > 0 ? 0.3 : 0);
      return { ...issue, score: Math.round(score * 100) / 100, sharedPaths };
    })
    .filter((issue) => issue.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed: ${(result.stderr || result.error || "").toString().trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}

function parseArgs(argv) {
  const out = { labels: [], audit: false, similar: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--title") out.title = argv[++i];
    else if (arg === "--body-file") out.bodyFile = argv[++i];
    else if (arg === "--label") out.labels.push(argv[++i]);
    else if (arg === "--audit") out.audit = true;
    else if (arg === "--no-similar") out.similar = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function printFindings(heading, { errors, warnings }) {
  if (errors.length === 0 && warnings.length === 0) return;
  console.log(heading);
  for (const e of errors) console.log(`  ✗ ${e}`);
  for (const w of warnings) console.log(`  · ${w}`);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  const args = parseArgs(process.argv.slice(2));

  if (args.audit) {
    const open = gh([
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      "500",
      "--json",
      "number,title,body,labels",
    ]);
    let failing = 0;
    for (const issue of open) {
      const result = lintIssue(
        { title: issue.title, body: issue.body ?? "", labels: issue.labels.map((l) => l.name) },
        { scanLeaks: true },
      );
      if (result.errors.length > 0) failing += 1;
      printFindings(`#${issue.number} ${issue.title}`, result);
    }
    console.log(`\nissue-check --audit: ${open.length} open, ${failing} not in the D-172 shape.`);
    process.exit(failing > 0 ? 1 : 0);
  }

  if (!args.title || !args.bodyFile) {
    console.error(
      'usage: issue-check.mjs --title "<title>" --body-file <path> [--label x]... | --audit',
    );
    process.exit(2);
  }

  const body = readFileSync(args.bodyFile, "utf8");
  const knownLabels = gh(["label", "list", "--limit", "200", "--json", "name"]).map((l) => l.name);
  const result = lintIssue({ title: args.title, body, labels: args.labels }, { knownLabels });
  printFindings("Draft:", result);

  if (args.similar) {
    const all = gh([
      "issue",
      "list",
      "--state",
      "all",
      "--limit",
      "1000",
      "--json",
      "number,title,body,state,stateReason",
    ]);
    const close = similarIssues({ title: args.title, body }, all);
    console.log(
      close.length === 0
        ? `\nNo existing issue scores as similar (${all.length} searched, open and closed). Still search by hand.`
        : `\nClosest existing issues (${all.length} searched, open and closed) — read each before filing:`,
    );
    for (const issue of close) {
      const state = issue.stateReason ? `${issue.state} ${issue.stateReason}` : issue.state;
      const paths = issue.sharedPaths.length > 0 ? `  shares ${issue.sharedPaths.join(", ")}` : "";
      console.log(
        `  ${issue.score.toFixed(2)}  #${issue.number} [${state}] ${issue.title}${paths}`,
      );
    }
  }

  if (result.errors.length > 0) {
    console.log(
      `\nissue-check: ${result.errors.length} error(s) — fix the draft before showing it.`,
    );
    process.exit(1);
  }
  console.log("\nissue-check: the draft is in shape.");
}
