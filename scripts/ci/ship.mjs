#!/usr/bin/env node
/**
 * Ship this commit to preview, or don't.
 *
 * Was a `&&` chain in package.json, which deployed for every commit — including
 * the many that change nothing a deploy would carry. A 20-30 minute build for a
 * docs-only change teaches you to stop running the command, which is worse than
 * the cost it saves.
 *
 * So it asks one question: did anything that can affect preview change since
 * the last time this machine shipped it (scripts/ci/relevance.mjs against the
 * release ledger). With no ledger record it ships: "I don't know" is not
 * "nothing changed".
 *
 *
 *   pnpm ship:preview
 *   pnpm ship:preview --force        # ship regardless of relevance
 *   pnpm ship:preview --gate         # run `pnpm gate:full` first
 *
 * `--gate` exists so one full-tier run can serve twice: it certifies the commit
 * before you hand-test preview, and promote reuses that same receipt instead of
 * spending another 20-40 minutes on the identical answer.
 */

import { readFileSync } from "node:fs";

import { RECEIPT_PATH, capture, fmtMs, git, lastRelease, run } from "./lib.mjs";
import { changedTargets } from "./relevance.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const force = flag("--force");
const env = "preview"; // production ships through `pnpm promote`, not this.

function die(message, ...rest) {
  console.error(`\n  ${message}`);
  for (const line of rest) console.error(`  ${line}`);
  console.error("");
  process.exit(1);
}

const sha = git.sha();

// ── Gate receipt ─────────────────────────────────────────────────────────────
// Not a gate of its own: the fast tier already ran at push time on this commit,
// and preview is where you find what tests can't. This only reports what the
// commit has been certified with, because "I tested it on preview" means less
// when the thing on preview was never gated.
if (flag("--gate")) {
  console.log("── Full gate (so promote can reuse this receipt)\n");
  if (run("node", ["scripts/ci/gate.mjs", "--tier", "full"]) !== 0) {
    die("Gate failed — nothing deployed.");
  }
} else {
  let receipt = null;
  try {
    receipt = JSON.parse(readFileSync(RECEIPT_PATH, "utf8"));
  } catch {
    /* no receipt is a normal state on a fresh clone */
  }
  if (!receipt || receipt.sha !== sha || !receipt.ok) {
    console.log(
      `\n  Note: no green gate receipt for ${git.shortSha()} on this machine.` +
        "\n  The pre-push hook gates the branch head, not the merge commit, so this is" +
        "\n  normal after a squash merge. `pnpm ship:preview --gate` runs the full tier" +
        "\n  first, and promote will then reuse that receipt.",
    );
  } else {
    console.log(
      `\n  Gate receipt: ${receipt.tier} tier, green, ${fmtMs(Date.now() - new Date(receipt.finishedAt).getTime())} old.`,
    );
  }
}

// ── What changed ─────────────────────────────────────────────────────────────
/** Files changed since `since`, or null when we have no baseline to compare to. */
function changedSince(since) {
  if (!since) return null;
  const out = capture("git", ["diff", "--name-only", `${since}..HEAD`]);
  // An empty diff is a real answer (nothing changed); a failed command is not,
  // and capture() flattens both to "". Distinguish them by asking git whether
  // the baseline commit is even in this history.
  if (!capture("git", ["cat-file", "-t", since])) return null;
  return out ? out.split("\n").filter(Boolean) : [];
}

const lastWeb = lastRelease({ kind: "web-deploy", env });

const webFiles = changedSince(lastWeb?.sha);

// null baseline ⇒ ship. Never read "no record" as "nothing to do".
const webNeeded = force || webFiles === null || changedTargets(webFiles).web;

const reason = (files, needed, last) => {
  if (force) return "forced";
  if (files === null) return last ? "no comparable record" : "never shipped from here";
  if (!files.length) return `no commits since ${last.sha.slice(0, 7)}`;
  return needed ? `${files.length} file(s) since ${last.sha.slice(0, 7)}` : "no relevant changes";
};

console.log(
  [
    "",
    `  commit  ${git.shortSha()}`,
    `  web     ${webNeeded ? "SHIP" : "skip"} — ${reason(webFiles, webNeeded, lastWeb)}`,
    "",
  ].join("\n"),
);

if (!webNeeded) {
  console.log("  Nothing to ship. (--force overrides.)\n");
  process.exit(0);
}

// ── Ship ─────────────────────────────────────────────────────────────────────
console.log("── Preview web\n");
if (run("bash", ["scripts/fly-deploy.sh", env]) !== 0) {
  die("The preview deploy failed.");
}

console.log("\n  ✓ preview is current.  (pnpm release:status)\n");
