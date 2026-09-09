#!/usr/bin/env node
/**
 * The gate (D-119) — one program, two machines.
 *
 * Runs the tier defined in scripts/ci/steps.mjs, writes a receipt bound to the
 * exact HEAD commit, and (when green, clean and pushed) posts the `local-gate`
 * commit status that branch protection on `main` requires.
 *
 * As of [D-157] it runs in TWO places, and it is deliberately the SAME program
 * in both: this laptop, driven by .githooks/pre-push, and
 * .github/workflows/gate.yml on a GitHub-hosted runner. The workflow does not
 * restate the step list — it invokes this with `--tier fast` and lets
 * steps.mjs decide. That is the property D-119 bought by making the registry
 * the single definition of "green", and re-adding Actions is only safe while
 * it holds: a workflow with its own copy of the steps is two definitions that
 * agree until the day they do not.
 *
 *   pnpm gate               # fast tier (what the PR gate used to run)
 *   pnpm gate:full          # + mutation, integration and the browser suites
 *   pnpm gate --tier heavy  # ONLY those three — what heavy.yml runs (D-161)
 *   pnpm gate --only lint,typecheck
 *   pnpm gate --skip audit
 *   pnpm gate --list
 *
 * Flags:
 *   --tier fast|heavy|full  which tier to run (default fast). `fast` and
 *                      `heavy` are the two halves; `full` is both, and is
 *                      the only one `pnpm promote` will accept a receipt for.
 *   --only a,b         run just these step ids
 *   --skip a,b         run everything but these
 *   --no-post          run the checks, never touch the commit status
 *   --allow-dirty      run with uncommitted changes (never posts a status)
 *   --no-lock          don't wait for the machine lock (see below)
 *   --list             print the steps and exit
 *   --json             with --list, print them as JSON instead of a table.
 *                      This is what .github/workflows/heavy.yml builds its
 *                      matrix from (D-161), so the set of jobs on a runner is
 *                      DERIVED from steps.mjs rather than typed into YAML —
 *                      a heavy step added to the registry gets a job in the
 *                      same commit, with no list anywhere to remember to widen.
 *   --quiet-header     skip the banner (used by the pre-push hook)
 *
 * Runs hold the MACHINE LOCK for their whole duration (D-146): several Claude
 * Code sessions work this repo at once, each in its own worktree, and the
 * suites here contend for one 16GB machine, one fixed-name Postgres container
 * and one port 3000. A contended run queues and says what it is waiting for
 * (`pnpm gate:lock` shows the queue). --no-lock is for the case where you have
 * reasoned about it and want the run anyway; it does not make the machine
 * bigger. A GitHub runner is a fresh VM with exactly one job on it, so
 * gate.yml passes --no-lock: there is nothing to serialize against, and a lock
 * file under a throwaway ~/.cache would only be ceremony.
 *
 * Exit code is the number of failed steps, capped at 1 — so `pnpm gate && …`
 * behaves.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { staleWarnings } from "../local/status.mjs";
import { RECEIPT_DIR, RECEIPT_PATH, color, dockerReady, fmtMs, git, has, runTee } from "./lib.mjs";
import { acquire, lockEnv } from "./lock.mjs";
import { postStatus } from "./status.mjs";
import { STEPS, TIERS, stepsForTier } from "./steps.mjs";

/**
 * The run's verdict as GitHub's job-summary markdown (D-157).
 *
 * This lives here rather than in the workflow because the gate is the only
 * thing that knows what it ran: a YAML step that re-derived the table would be
 * the same drift the registry exists to prevent, one presentation layer
 * removed. The receipt already holds every field — this is a rendering of it,
 * not a second source.
 *
 * Best-effort by construction. A summary that fails to write must never turn a
 * green run red; the checks are the verdict and this is how it reads.
 */
function writeStepSummary({ receipt, steps }) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;

  const notReached = steps.length - receipt.steps.length;
  const lines = [
    `## ${receipt.ok ? "✅ Green" : "❌ Red"} · ${receipt.tier} tier · ${fmtMs(receipt.durationMs)}`,
    "",
    `\`${receipt.sha.slice(0, 7)}\` · ${receipt.steps.length}/${steps.length} steps run`,
    "",
    "| | Step | Time |",
    "| --- | --- | --- |",
  ];
  for (const r of receipt.steps) {
    const step = STEPS.find((s) => s.id === r.id);
    lines.push(`| ${r.ok ? "✅" : "❌"} | ${step?.title ?? r.id} | ${fmtMs(r.ms)} |`);
  }
  if (notReached > 0) {
    // The gate stops at the first failure, so the untouched steps are unknown
    // rather than passing. Saying "not reached" keeps a reader from reading a
    // short table as a short tier.
    lines.push(`| ⏭️ | _${notReached} step(s) not reached — the gate stops at the first red_ | |`);
  }
  lines.push("", "Steps come from `scripts/ci/steps.mjs`, which is the same registry `pnpm gate`");
  lines.push("runs on the operator's laptop. This workflow does not define any of them.");

  try {
    appendFileSync(path, `${lines.join("\n")}\n`);
  } catch {
    // Nothing to do and nothing worth failing for.
  }
}

function parseArgs(argv) {
  const args = {
    tier: "fast",
    only: null,
    skip: [],
    post: true,
    allowDirty: false,
    lock: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tier") args.tier = argv[++i];
    else if (a === "--only") args.only = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--skip") args.skip = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--no-post") args.post = false;
    else if (a === "--allow-dirty") args.allowDirty = true;
    else if (a === "--no-lock") args.lock = false;
    else if (a === "--list") args.list = true;
    else if (a === "--json") args.json = true;
    else if (a === "--quiet-header") args.quietHeader = true;
    else if (a === "--full") args.tier = "full";
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  if (!TIERS.includes(args.tier)) {
    console.error(`unknown tier: ${args.tier} (want ${TIERS.join("|")})`);
    process.exit(2);
  }
  return args;
}

function selectSteps(args) {
  let steps = stepsForTier(args.tier);
  if (args.only) {
    const known = new Set(STEPS.map((s) => s.id));
    const unknown = args.only.filter((id) => !known.has(id));
    if (unknown.length) {
      console.error(`unknown step id(s): ${unknown.join(", ")}`);
      process.exit(2);
    }
    // --only reaches into the full registry, so `--only e2e` works from the
    // fast tier without also having to pass --tier full.
    steps = STEPS.filter((s) => args.only.includes(s.id));
  }
  return steps.filter((s) => !args.skip.includes(s.id));
}

async function runGate(argv = []) {
  const args = parseArgs(argv);
  const steps = selectSteps(args);

  if (args.list) {
    if (args.json) {
      // One object per step, which is exactly a GitHub Actions matrix leg.
      // Deliberately not the whole Step: `cmd` is what the runner must NOT
      // see, because a workflow that can read the argv is one edit away from
      // running it directly and becoming the second definition this registry
      // exists to prevent.
      console.log(
        JSON.stringify(steps.map(({ id, title, tier, needs }) => ({ id, title, tier, needs }))),
      );
      return 0;
    }
    for (const s of steps) console.log(`${s.id.padEnd(14)} ${s.tier.padEnd(5)} ${s.title}`);
    return 0;
  }

  const sha = git.sha();
  const dirty = git.isDirty();
  if (dirty && !args.allowDirty) {
    console.error(
      [
        "",
        "  The working tree has uncommitted changes.",
        "",
        `  The gate certifies a COMMIT (${git.shortSha()}), not a working tree — a status posted`,
        "  from a dirty run would vouch for bytes GitHub never sees. Commit first, or",
        "  re-run with --allow-dirty to check the tree without posting a status.",
        "",
      ].join("\n"),
    );
    return 1;
  }

  const missingDocker = steps.some((s) => s.needs?.includes("docker")) && !dockerReady();
  if (missingDocker) {
    console.error(
      [
        "",
        "  Docker isn't running, and the integration + E2E steps need a Postgres container.",
        "  Start Docker (or OrbStack) and re-run, or skip them:",
        "",
        "    pnpm gate:full --skip integration,e2e",
        "",
      ].join("\n"),
    );
    return 1;
  }

  // Same shape as the Docker check above, and same reasoning: a prerequisite
  // that is missing must stop the run with an instruction, not let the step
  // fail with a shell error two minutes later. gitleaks is deliberately NOT a
  // pnpm dependency — the npm package of that name is a third party's,
  // unrelated to the tool, and taking a credential scanner from it is the
  // supply-chain shape the scanner exists to catch. See .gitleaks.toml.
  const missingGitleaks = steps.some((s) => s.needs?.includes("gitleaks")) && !has("gitleaks");
  if (missingGitleaks) {
    console.error(
      [
        "",
        "  gitleaks isn't installed, and the credential scan needs it.",
        "",
        "    brew install gitleaks",
        "",
        "  ⚠ Not `pnpm add gitleaks` — that npm package is unrelated to this tool.",
        "  To run the rest of the tier without it:",
        "",
        "    pnpm gate --skip secret-scan",
        "",
      ].join("\n"),
    );
    return 1;
  }

  // Where this run's per-step output lands — one file each, so a step that
  // scrolled off-screen (or one that passed quietly) can still be read back
  // without re-running it.
  const logDir = resolve(RECEIPT_DIR, "logs", `${git.shortSha()}-${args.tier}`);

  if (!args.quietHeader) {
    console.log(
      `\n▶ local gate · ${args.tier} tier · ${steps.length} steps · ${git.branch()} @ ${git.shortSha()}\n`,
    );
    // The plan up front: what's about to run, in order, before any of it
    // starts producing tool output — so a step that's still "pending" 20
    // minutes in reads as pending, not as having vanished into scrollback.
    for (const [i, s] of steps.entries()) {
      console.log(`  ${color.dim(`${i + 1}.`.padEnd(3))} ${s.title} ${color.dim(`(${s.id})`)}`);
    }
    console.log(`\n  logs: ${color.dim(logDir)}`);
  }

  // One heavy job on this machine at a time (D-146). Several Claude Code
  // sessions push at once, and the suites below contend for a 16GB machine, one
  // fixed-name Postgres container and one port 3000 — see lock.mjs for what
  // each of those does when two runs overlap. Taken here rather than in the
  // pre-push hook so that every entry point is covered: a hand-run
  // `pnpm gate`, `pnpm promote`, and the hook all queue on the same lock.
  //
  // Deliberately AFTER the dirty and Docker checks: those fail in milliseconds,
  // and making a run wait 20 minutes for the machine only to reject it for an
  // uncommitted file would be a bad trade.
  // Never quiet, even under --quiet-header: a push that is silently waiting on
  // another session's gate is indistinguishable from a hung push.
  const lock = args.lock
    ? await acquire({ label: `gate · ${args.tier}` })
    : { release: () => {}, touch: () => {}, token: null };

  const results = [];
  const startedAll = Date.now();
  for (const [i, step] of steps.entries()) {
    const started = Date.now();
    console.log(
      `\n${color.cyan(`── [${i + 1}/${steps.length}]`)} ${step.title} ${color.dim(`(${step.id})`)}`,
    );
    lock.touch({ step: step.id });
    const logPath = resolve(logDir, `${step.id}.log`);
    const code = await runTee(step.cmd[0], step.cmd.slice(1), {
      // The token tells integration.sh and e2e.sh that the machine is already
      // ours, so they pass through their own acquire instead of deadlocking.
      env: { ...step.env, ...(lock.token ? lockEnv(lock.token) : {}) },
      logPath,
    });
    const ms = Date.now() - started;
    const ok = code === 0;
    results.push({ id: step.id, ok, ms, log: logPath });
    const mark = ok ? color.green("✓") : color.red("✗");
    console.log(`   ${mark} ${step.id} — ${fmtMs(ms)}`);
    if (!ok) {
      // Fail fast: the remaining steps cost minutes and the answer is already
      // "not mergeable". --only re-runs the one you just fixed.
      console.log(`\n   full output: ${logPath}`);
      console.log(`   stopping — re-run just this step with:  pnpm gate --only ${step.id}\n`);
      break;
    }
  }

  // Hand the machine on the moment the last suite exits. Everything below —
  // the summary, the receipt, the status post, the staleness nag — is
  // milliseconds of local work and a network call, and making the next session
  // in the queue wait for it would be pure latency.
  lock.release();

  const ok = results.length === steps.length && results.every((r) => r.ok);
  const totalMs = Date.now() - startedAll;

  console.log(`\n${"─".repeat(60)}`);
  for (const r of results) {
    const mark = r.ok ? color.green("✓") : color.red("✗");
    console.log(`  ${mark} ${r.id.padEnd(14)} ${fmtMs(r.ms)}`);
  }
  const skipped = steps.length - results.length;
  if (skipped > 0) console.log(`  ${color.dim(`· ${skipped} step(s) not reached`)}`);
  console.log(`${"─".repeat(60)}`);
  console.log(
    `  ${ok ? color.green("GREEN") : color.red("RED")} · ${args.tier} tier · ${fmtMs(totalMs)}\n`,
  );

  const receipt = {
    sha,
    tier: args.tier,
    ok,
    dirty,
    host: hostname(),
    finishedAt: new Date().toISOString(),
    durationMs: totalMs,
    steps: results,
    logDir,
  };
  mkdirSync(RECEIPT_DIR, { recursive: true });
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);

  // On a runner, the receipt is thrown away with the VM. The summary tab is
  // where it survives, and it is the difference between a reviewer reading a
  // verdict and a reviewer opening logs (D-157).
  writeStepSummary({ receipt, steps });

  if (args.post && !dirty && !args.only) {
    postStatus({ receipt });
  } else if (args.post && args.only) {
    console.log("  (partial run — no status posted; run the whole tier to certify the commit)\n");
  }

  // The maintenance nag (D-129). Nothing schedules the backup, the production
  // probes or the time-bomb sweep any more — there is no Actions cron and no
  // laptop scheduler — so the only thing standing between "run by hand" and
  // "not run since July" is being told. This is the moment to tell: the
  // pre-push hook runs the gate on every push, so the operator is provably
  // here, and it prints nothing at all while everything is current.
  //
  // Deliberately after the verdict and deliberately not part of it: a stale
  // backup is not a reason to fail a commit.
  //
  // Never on a runner (D-157). The nag's entire mechanism is that it reaches
  // the operator at a moment they are provably at the keyboard; a GitHub
  // runner has no `.gate/local-jobs.json` at all, so it would report every job
  // as never-run, on every PR, to nobody. A warning that is always on is a
  // warning that gets skimmed — and this banner is the only signal the
  // remaining jobs have.
  const overdue = process.env.CI ? [] : staleWarnings();
  if (overdue.length > 0) {
    console.log(
      `  ${color.yellow("maintenance overdue")} ${color.dim("(nothing runs these but you)")}`,
    );
    for (const line of overdue) console.log(`    ${color.dim(line)}`);
    console.log(`    ${color.dim("details: pnpm local:status")}\n`);
  }

  return ok ? 0 : 1;
}

process.exit(await runGate(process.argv.slice(2)));
