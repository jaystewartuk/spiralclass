#!/usr/bin/env node
/**
 * Posts the `local-gate` commit status that branch protection on `main`
 * requires (D-119).
 *
 * This is the load-bearing half of a gate that runs before the push rather
 * than after it: the checks run here, but the PR still has to show that they
 * did. It is a commit STATUS, posted through the REST API — not a workflow —
 * which is why it survived D-129 having deleted every workflow in this repo,
 * and why it needs no change now that [D-157] has brought some back. A commit
 * status is bound to ONE commit SHA, so a green status can't drift onto later
 * work — push a new commit and the PR goes back to "waiting" until that commit
 * is certified too. That property is what makes a locally-run gate worth
 * anything.
 *
 * TWO PRODUCERS POST THIS CONTEXT, and they run the same registry
 * (scripts/ci/steps.mjs), so they cannot disagree about anything but timing:
 * this script from the laptop, and .github/workflows/gate.yml's `status` job
 * from a runner. Whichever reports last for a given SHA wins.
 *
 * It is self-attested by construction: nothing stops someone posting green by
 * hand. That's an accepted trade for a solo repo (see D-119) — the value is the
 * mechanical "did you actually run it against THIS commit", not protection from
 * a determined operator lying to themselves.
 *
 *   node scripts/ci/status.mjs                 # post from the last receipt
 *   node scripts/ci/status.mjs --wait          # …once the commit reaches origin
 *   node scripts/ci/status.mjs --state pending --description "gate running"
 *
 * Needs `gh` authenticated with repo scope. Without it (a cloud session, a
 * borrowed machine) nothing is posted from here — but as of [D-157] the PR's
 * own Gate workflow posts the same context on its own, so a laptop-less day is
 * a complete substitute again rather than a stranded PR.
 */

import { readFileSync } from "node:fs";

import { RECEIPT_PATH, capture, fmtMs, git, has, repoSlug } from "./lib.mjs";

/**
 * The required status-check context on `main`. THREE places must agree on this
 * string: here, scripts/setup-branch-protection.sh, and the `status` job in
 * .github/workflows/gate.yml.
 * apps/web/tests/config/local-gate.test.ts locks them together.
 */
export const CONTEXT = "local-gate";

const FALLBACK = [
  "  No `gh` CLI available, so no status was posted from here.",
  "  The checks above still ran. On a PR, .github/workflows/gate.yml runs the same",
  "  tier and posts this same context, so the PR is not stranded — or re-run",
  "  `pnpm gate:status` from a machine with `gh`.",
].join("\n");

function ghAvailable() {
  return has("gh") && capture("gh", ["auth", "status"]) !== "";
}

/** Poll until the commit is visible on origin (a push may still be in flight). */
function waitForOrigin(sha, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    capture("git", ["fetch", "--quiet", "origin"]);
    if (git.isOnOrigin(sha)) return true;
    // Cheap synchronous sleep — this runs detached from the pre-push hook.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
  }
  return false;
}

function describe(receipt) {
  const n = receipt.steps.length;
  const failed = receipt.steps.filter((s) => !s.ok).map((s) => s.id);
  const where = `${receipt.tier} tier · ${receipt.host}`;
  return receipt.ok
    ? `${n} checks in ${fmtMs(receipt.durationMs)} · ${where}`
    : `failed: ${failed.join(", ") || "incomplete"} · ${where}`;
}

/**
 * @param {{receipt: object, wait?: boolean, state?: string, description?: string}} opts
 * @returns {boolean} whether a status was posted
 */
export function postStatus({ receipt, wait = false, state, description }) {
  if (process.env.GATE_NO_POST === "1") return false;

  const sha = receipt?.sha ?? git.sha();
  const finalState = state ?? (receipt.ok ? "success" : "failure");
  const desc = (description ?? describe(receipt)).slice(0, 140);

  if (!ghAvailable()) {
    console.log(`\n${FALLBACK}\n`);
    return false;
  }

  const slug = repoSlug();
  if (!slug) {
    console.log("\n  Could not parse the origin remote — no status posted.\n");
    return false;
  }

  if (!git.isOnOrigin(sha)) {
    if (!wait) {
      console.log(
        [
          "",
          `  ${sha.slice(0, 7)} isn't on origin yet, so there's nothing to attach a status to.`,
          "  Push, then:  pnpm gate:status",
          "",
        ].join("\n"),
      );
      return false;
    }
    if (!waitForOrigin(sha)) {
      console.log(`\n  ${sha.slice(0, 7)} never reached origin — no status posted.\n`);
      return false;
    }
  }

  const code = capture("gh", [
    "api",
    "-X",
    "POST",
    `repos/${slug}/statuses/${sha}`,
    "-f",
    `state=${finalState}`,
    "-f",
    `context=${CONTEXT}`,
    "-f",
    `description=${desc}`,
  ]);

  if (code === "") {
    console.log(`\n  Could not post the ${CONTEXT} status (see gh output above).\n`);
    return false;
  }
  console.log(`\n  ✓ posted ${CONTEXT}=${finalState} on ${sha.slice(0, 7)} — ${desc}\n`);
  return true;
}

function main(argv) {
  const args = { wait: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--wait") args.wait = true;
    else if (argv[i] === "--sha") args.sha = argv[++i];
    else if (argv[i] === "--state") args.state = argv[++i];
    else if (argv[i] === "--description") args.description = argv[++i];
    else {
      console.error(`unknown flag: ${argv[i]}`);
      process.exit(2);
    }
  }

  let receipt;
  try {
    receipt = JSON.parse(readFileSync(RECEIPT_PATH, "utf8"));
  } catch {
    console.error(
      "\n  No gate receipt found (.gate/receipt.json). Run `pnpm gate` first.\n" +
        "  A status is only ever posted for a run that actually happened.\n",
    );
    process.exit(1);
  }

  if (args.sha && args.sha !== receipt.sha) {
    console.error(
      `\n  Receipt is for ${receipt.sha.slice(0, 7)}, but ${args.sha.slice(0, 7)} was requested.\n` +
        "  Re-run `pnpm gate` against the commit you want to certify.\n",
    );
    process.exit(1);
  }

  const posted = postStatus({ ...args, receipt });
  process.exit(posted ? 0 : 1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2));
}
