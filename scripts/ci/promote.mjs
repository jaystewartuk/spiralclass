#!/usr/bin/env node
/**
 * Promote to production (D-119).
 *
 * NEITHER THE GATE NOR THE DEPLOY RUNS HERE ANY MORE ([D-157], [D-162]). This
 * script READS the runners' verdict on the exact commit — the Gate and Heavy
 * workflows, both green for this SHA, from their push-to-`main` runs — and then
 * fast-forwards the `production` branch. That push triggers
 * .github/workflows/deploy-production.yml: a database job (migrations behind a
 * Neon checkpoint), then the same scripts/fly-deploy.sh this used to invoke
 * directly — the amd64 image, the Fly deploy, the Inngest sync, the production
 * probes — alongside the Vercel failover, which does not wait for Fly. Promote
 * judges production by the database and Fly jobs, and reports the failover on
 * its own line (scripts/ci/deploy-verdict.mjs).
 *
 * WHY THE DEPLOY MOVED, AND WHY THAT IS NOT THE 2026-07-19 DRIFT AGAIN.
 * D-120 chained the deploy into this command because a HUMAN DISPATCH STEP had
 * left `production` 96 commits behind what was live. The chain is what
 * mattered, not where the build ran — and it is intact: the push at the end of
 * this script IS the trigger, so there is still nothing to remember. The
 * `production` environment's required reviewer adds a deliberate look before
 * migrations touch live payment records, and unlike a forgotten dispatch a
 * pending approval is visible: a queued run in the Actions tab, and
 * `pnpm release:status` still red while the branch is ahead of what shipped.
 *
 * What this buys, and it is the whole reason: the image is built on a NATIVE
 * amd64 runner. On this arm64 laptop it was a QEMU cross-build — 20-30+
 * minutes, flaky with threaded native addons — which made a promote something
 * you scheduled rather than something you did. If Actions is unavailable,
 * `./scripts/fly-deploy.sh production --gate-already-passed` still deploys
 * from here; that path is unchanged and is also the recovery path.
 *
 * There is no second half any more. This script once finished by running a
 * release for it, on the argument that a promote ending with half the product
 * shipped is not a promote; that half is deleted, so the arm and its flag are
 * gone rather than defaulted off. `--mobile` and `--no-mobile` are still
 * ACCEPTED and are no-ops, so a runbook or a habit that passes one keeps
 * working instead of dying on an unknown flag.
 *
 *   pnpm promote            # certify + fast-forward + release tag + watch the deploy
 *   pnpm promote --yes      # no confirmation prompt
 *   pnpm promote --force-gate # run the full tier HERE instead of reading the runners
 *   pnpm promote --no-wait    # stop once production is fast-forwarded
 *
 * `--no-deploy` is still ACCEPTED and now means `--no-wait`. It cannot suppress
 * the deploy any more — the push IS the trigger — and saying so out loud beats
 * silently ignoring a flag someone reached for expecting it to hold production
 * back.
 *
 * To promote an older reviewed commit, check it out first (`git checkout <sha>`)
 * and run this — the certification is bound to the exact commit that ships.
 *
 * ⚠️ An older commit may have aged out of what this can read: GitHub expires
 * workflow runs, and a run that no longer exists is not a green one. That is a
 * refusal, and `--force-gate` is the answer — certify it here.
 *
 * No PROMOTE_TOKEN is involved. That PAT existed because a push made with
 * GITHUB_TOKEN never triggers other workflows; a push from your own
 * credentials does, which is exactly what the fast-forward below is.
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { recordRun } from "../local/receipts.mjs";
import { deployVerdict, failoverLine } from "./deploy-verdict.mjs";
import { capture, check, git, has, lastRelease, run } from "./lib.mjs";

const args = process.argv.slice(2);
const yes = args.includes("--yes") || args.includes("-y");
// Accepted and inert. It used to mean "reuse the local full-tier receipt"; there
// is no receipt any more ([D-162]), and the runners either certified this commit
// or they did not. Kept so a runbook or a habit that passes it keeps working
// rather than dying on an unknown flag — the same treatment `--mobile` got.
const skipGate = args.includes("--skip-gate");
const forceGate = args.includes("--force-gate");
// --no-deploy is the old spelling and is kept working; see the header for why
// it can no longer mean "do not deploy".
const noWait = args.includes("--no-wait") || args.includes("--no-deploy");

function die(message, ...rest) {
  console.error(`\n  ${message}`);
  for (const line of rest) console.error(`  ${line}`);
  console.error("");
  process.exit(1);
}

// ── Preflight ────────────────────────────────────────────────────────────────
if (git.isDirty()) {
  die("Working tree is dirty.", "Promote ships a commit, not a tree — commit or stash first.");
}

// Refuse BEFORE the fast-forward if nothing is listening for it.
//
// This script's whole anti-drift property is that the push to `production` IS
// the deploy trigger, so there is no step left to forget. Take that trigger
// away and the property inverts: promote would move the branch, wait a minute
// for a run that can never start, and leave `production` ahead of what is live
// — the 2026-07-19 incident exactly, reached from the other direction.
//
// Read off the workflow rather than hardcoded, so restoring the trigger clears
// this with no second edit to remember. Deliberately not a `gh` call: it has to
// work offline, and the question is about a file in this checkout.
try {
  const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");
  const triggers = workflow.split(/^on:$/m)[1]?.split(/^\S/m)[0] ?? "";
  if (!/^\s+push:/m.test(triggers)) {
    die(
      "The production deploy workflow has no `push` trigger, so fast-forwarding",
      "`production` would move the branch and deploy nothing.",
      "",
      "Production deploys to Fly and that workflow's trigger is supposed to be",
      "live (D-150's second addendum, D-157's addendum 2). If it has been taken",
      "off, put it back rather than working around this.",
      "",
      "Nothing is broken — production is still serving whatever shipped last.",
    );
  }
} catch (error) {
  // No workflow file at all is the pre-D-157 world, where promote deployed
  // directly. Nothing to check there, and refusing would be wrong.
  if (error?.code !== "ENOENT") throw error;
}

console.log("── Fetching origin");
run("git", ["fetch", "--no-tags", "--quiet", "origin", "main", "production"]);

const sha = git.sha();
const short = sha.slice(0, 7);

if (!check("git", ["merge-base", "--is-ancestor", sha, "origin/main"])) {
  die(
    `HEAD (${short}) is not on origin/main.`,
    "Only a commit that has landed on main through a PR can be promoted.",
    "Fix:  git checkout main && git pull",
  );
}

const productionSha = capture("git", ["rev-parse", "origin/production"]);
if (productionSha === sha) {
  die(`origin/production is already at ${short} — nothing to promote.`);
}
if (!check("git", ["merge-base", "--is-ancestor", productionSha, sha])) {
  die(
    `origin/production (${productionSha.slice(0, 7)}) is not an ancestor of ${short}.`,
    "The promote push is fast-forward only (the production ruleset blocks anything else).",
    "Someone pushed to production out of band — reconcile before promoting.",
  );
}

const behind = capture("git", ["rev-list", "--count", `${productionSha}..${sha}`]);
console.log(`\n  Promoting ${short} — ${behind} commit(s) ahead of production.\n`);
console.log(capture("git", ["log", "--oneline", `${productionSha}..${sha}`]));

// ── Gate ─────────────────────────────────────────────────────────────────────
// WHAT CERTIFIES THE COMMIT THAT SHIPS ([D-162]).
//
// The runners do. `gate.yml` runs the fast tier and `heavy.yml` runs the
// mutation spot-check, integration and the browser suites, both on every push
// to `main` — so the tree that landed is the tree that was tested, on a machine
// nobody had to remember to use.
//
// This replaces a local full-tier receipt written by `pnpm ship-pr`, which
// D-162 deleted. That receipt was a self-attestation: a file this script wrote
// and then believed. What replaces it is bound to the same SHA, produced by the
// machine that also builds the production image, and checkable by anyone with
// the repository open.
//
// ⚠️ THIS FAILS CLOSED. Every branch below is a refusal, not a warning — no
// `gh`, no network, an API shape that moved, a run still going. An unreadable
// answer is not a green one, and the single thing that must never happen here
// is shipping a commit because nothing could be found to say it was broken.
const CERTIFYING_WORKFLOWS = ["Gate", "Heavy"];

/**
 * The runners' verdict on this exact commit, as { workflow name -> verdict }.
 *
 * Only `push` runs count. A `pull_request` run's head SHA is the branch tip,
 * which a squash merge does not preserve — the commit on `main` is a different
 * object that run never saw. Asking for the push run is what makes "this exact
 * commit" true rather than nearly true.
 *
 * Returns null when the answer cannot be read at all, which the caller treats
 * as a refusal.
 */
function runnerVerdicts() {
  if (!has("gh")) return null;
  const raw = capture("gh", [
    "api",
    `repos/{owner}/{repo}/actions/runs?head_sha=${sha}&per_page=100`,
    "--jq",
    '[.workflow_runs[] | select(.event == "push") | {name, status, conclusion, created_at}]',
  ]);
  if (!raw) return null;
  try {
    const runs = JSON.parse(raw);
    if (!Array.isArray(runs)) return null;
    // ⚠️ Pick the NEWEST run per workflow explicitly, by timestamp.
    //
    // The API does return them newest-first today, and the shorter version of
    // this took the first entry seen. That is an undocumented ordering this
    // code would depend on silently, and the direction it fails in is the
    // wrong one: a stale green ahead of a newer red would CERTIFY. Every other
    // unknown on this path is a refusal, so this one has to be too.
    //
    // More than one push run per workflow per SHA is ordinary — a re-run from
    // the Actions tab after a flake is exactly that.
    const verdicts = {};
    const newest = {};
    for (const r of runs) {
      const at = Date.parse(r.created_at ?? "");
      // An unparseable timestamp sorts oldest rather than winning by accident.
      const stamp = Number.isNaN(at) ? -Infinity : at;
      if (!(r.name in newest) || stamp > newest[r.name]) {
        newest[r.name] = stamp;
        verdicts[r.name] = r.status === "completed" ? r.conclusion : r.status;
      }
    }
    return verdicts;
  } catch {
    return null;
  }
}

if (forceGate) {
  // The escape hatch, and the recovery path: Actions being unreachable must
  // never be the reason production cannot be fixed. Same property D-157
  // insisted on for the deploy.
  console.log("── --force-gate: certifying on this machine instead of reading the runners\n");
  const code = run("node", ["scripts/ci/gate.mjs", "--tier", "full"]);
  if (code !== 0) die("Gate failed — production untouched.");
} else {
  const verdicts = runnerVerdicts();
  if (!verdicts) {
    die(
      `Could not read the runners' verdict for ${short}.`,
      "That is a refusal, not a pass — gh may be missing, unauthenticated or offline.",
      "`pnpm promote --force-gate` certifies this commit on this machine instead.",
    );
  }

  const problems = [];
  for (const name of CERTIFYING_WORKFLOWS) {
    const verdict = verdicts[name];
    if (verdict === "success") continue;
    if (verdict === undefined) {
      problems.push(`${name}: no push run for this commit`);
    } else if (["in_progress", "queued", "waiting", "pending"].includes(verdict)) {
      problems.push(`${name}: still ${verdict.replace("_", " ")} — wait for it`);
    } else {
      problems.push(`${name}: ${verdict}`);
    }
  }

  if (problems.length) {
    die(
      `${short} is not certified by the runners:`,
      ...problems.map((p) => `  · ${p}`),
      "",
      "Nothing about production has changed. Fix the red run, or wait for a pending",
      "one, and promote again. `pnpm promote --force-gate` certifies it here instead.",
    );
  }

  console.log(`  Certified by the runners for ${short}: ${CERTIFYING_WORKFLOWS.join(" + ")}.`);
  console.log("  (--force-gate runs the full tier here instead.)\n");
}

// ── Was this commit ever on preview? ─────────────────────────────────────────
// A warning, not a gate: hotfixes exist, and the ledger only knows what this
// machine shipped. But "promoted a commit nobody ever ran" is worth one line of
// friction, and until the ledger existed nothing could say it at all.
const previewWeb = lastRelease({ kind: "web-deploy", env: "preview" });
if (previewWeb?.sha !== sha) {
  console.log(
    [
      `  Note: no record of ${short} on preview` +
        `${previewWeb ? ` (last preview deploy: ${previewWeb.sha.slice(0, 7)})` : ""}.`,
      "  `pnpm ship:preview` first if you meant to hand-test this commit.",
      "",
    ].join("\n"),
  );
}

// ── Confirm ──────────────────────────────────────────────────────────────────
if (!yes) {
  if (!process.stdin.isTTY) die("Not a TTY — re-run with --yes to promote non-interactively.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\n  Fast-forward production to ${short} and deploy to spiralclass.com? [y/N] `,
  );
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) die("Aborted. Nothing pushed.");
}

// ── Promote ──────────────────────────────────────────────────────────────────
console.log("\n── Fast-forwarding production");
if (run("git", ["push", "origin", `${sha}:refs/heads/production`]) !== 0) {
  die("The push to production failed — see git's output above.");
}

// ── Release tag ──────────────────────────────────────────────────────────────
// Same scheme promote.yml used: v<UTC date>.<n-th release that day>.
if (has("gh")) {
  run("git", ["fetch", "--tags", "--force", "--quiet", "origin"]);
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", ".");
  const existing = capture("git", ["tag", "-l", `v${date}.*`])
    .split("\n")
    .filter(Boolean).length;
  const tag = `v${date}.${existing + 1}`;
  const code = run("gh", [
    "release",
    "create",
    tag,
    "--target",
    sha,
    "--title",
    tag,
    "--generate-notes",
  ]);
  if (code === 0) console.log(`  ✓ released ${tag}`);
  else console.log(`  (release tag ${tag} was not created — not fatal, promote succeeded)`);
} else {
  console.log("  (no gh CLI — skipping the release tag)");
}

// ── Deploy ───────────────────────────────────────────────────────────────────
// The push above IS the deploy trigger ([D-157]): it moved `production`, using
// the operator's own credentials, so deploy-production.yml fires. That workflow
// migrates in its database job, then runs the same scripts/fly-deploy.sh this
// used to run here, the probes, and — not waiting on Fly — the Vercel failover.
//
// The chain D-120 insisted on is intact — nothing here is left for a human to
// remember. What IS left for a human is the approvals on the `production`
// environment, which GitHub asks for per job: the database job, then the two
// targets together. Each is a queued run with a notification rather than a
// step that can be silently skipped. See deploy-production.yml's header.
const RUN_URL = `https://github.com/${capture("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]) || "jaystewartuk/spiralclass"}/actions/workflows/deploy-production.yml`;

let deployOk = true;
let failover = "";
if (noWait || !has("gh")) {
  console.log(
    [
      "",
      "  production is fast-forwarded; the deploy workflow has been triggered by that push.",
      `  Approve and watch it:  ${RUN_URL}`,
      "  Deploy from here instead:  ./scripts/fly-deploy.sh production --gate-already-passed",
      "",
    ].join("\n"),
  );
} else {
  console.log("\n── Waiting for the deploy workflow");
  console.log(
    `  It needs two approvals on the production environment — the database job, then both targets: ${RUN_URL}\n`,
  );
  // Matched on the HEAD SHA, not "the most recent run on this branch" — the
  // previous promote's run is also on this branch, and watching that one would
  // report a green deploy of the commit before this one.
  //
  // Polled, because GitHub takes a moment to register a run against a push
  // that landed seconds ago; an empty first answer is normal, not an error.
  const findRun = () =>
    capture("gh", [
      "run",
      "list",
      "--workflow",
      "deploy-production.yml",
      "--limit",
      "20",
      "--json",
      "databaseId,headSha",
      "-q",
      `[.[] | select(.headSha == "${sha}")][0].databaseId`,
    ]);

  let runId = "";
  for (let i = 0; i < 12 && !runId; i++) {
    runId = findRun();
    if (!runId) await new Promise((r) => setTimeout(r, 5_000));
  }

  if (!runId) {
    console.log(
      [
        `  No deploy run appeared for ${short} within a minute.`,
        "  Check the Actions tab, or deploy from here:",
        "    ./scripts/fly-deploy.sh production --gate-already-passed",
        "",
      ].join("\n"),
    );
    deployOk = false;
  } else {
    // `gh run watch` blocks through the approval waits and the run itself.
    // Ctrl-C only stops watching; the deploy carries on.
    //
    // ⚠️ NOT `--exit-status`, which answers for the RUN — red whenever any job
    // is. Since the targets were split ([D-177]'s addendum), a Vercel failover
    // that could not refresh would have turned a Fly release that shipped into
    // a promote reporting that production may not have moved. So the verdict
    // is read job by job, and a promote that ends green still means exactly
    // what it always has: production is serving this commit.
    run("gh", ["run", "watch", runId]);
    let jobs = [];
    try {
      jobs = JSON.parse(capture("gh", ["run", "view", runId, "--json", "jobs"]) || "{}").jobs ?? [];
    } catch {
      // Unreadable is not green. deployVerdict([]) reports every job missing.
    }
    const verdict = deployVerdict(jobs);
    deployOk = verdict.productionOk;
    failover = failoverLine(verdict.vercel);
    if (!deployOk) {
      console.log(`\n  Database job: ${verdict.database}. Fly job: ${verdict.fly}. Run: ${runId}`);
    }

    // The workflow ran the production probes as its last step, so record that
    // here. The nag in `pnpm gate` asks "when did this last SUCCEED", and the
    // answer really is "just now" — leaving the receipt unwritten would print a
    // standing warning about a job that had in fact just run, which is the
    // banner-nobody-reads failure D-129's addendum warned about.
    if (deployOk) {
      recordRun("synthetic", {
        ok: true,
        at: new Date().toISOString(),
        durationMs: 0,
        host: "github-actions",
        exitCode: 0,
        log: `${RUN_URL.replace("/workflows/deploy-production.yml", "")}/${runId}`,
      });
    }
  }
}

console.log(
  [
    "",
    `  ✓ production branch → ${short}`,
    "",
    deployOk
      ? "  Deployed by GitHub Actions: Neon checkpoint and migrations, native amd64 image,"
      : "  ⚠ The deploy did NOT finish green. `production` moved and the running app may not have.",
    deployOk
      ? "    Fly deploy, Inngest sync, then the production probes."
      : "    Recover from here:  ./scripts/fly-deploy.sh production --gate-already-passed",
    ...(failover ? ["", failover] : []),
    "",
    "  Where things stand:  pnpm release:status",
    "  ⚠️ A deploy run by Actions leaves no entry in the local ledger, so that",
    "     command reports it as 'no local record' rather than as not shipped.",
    "",
  ].join("\n"),
);

// The exit code is the only part of this a script or a scrollback-skimming
// human reliably sees, so it has to mean "production is serving this commit".
if (!deployOk) process.exit(1);
