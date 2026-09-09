#!/usr/bin/env node
/**
 * Runs one hand-run maintenance task, records that it happened, and makes a
 * failure impossible to miss (D-129).
 *
 *   pnpm local synthetic    # probe production
 *   pnpm local sweep        # unit suites + audit against today's clock
 *   pnpm local:status       # when did each of these last succeed?
 *
 * This wrapper exists for the two things the deleted GitHub Actions crons gave
 * for free and a bare shell script does not: a record that the run happened,
 * and a push notification when it didn't work. Actions had a run history and an
 * emailed failure; a script run in a terminal has neither the moment the window
 * is closed.
 */

import { hostname } from "node:os";
import { resolve } from "node:path";

import { REPO_ROOT, color, fmtMs, run, runTee } from "../ci/lib.mjs";
import { JOB_IDS, jobById } from "./jobs.mjs";
import { recordRun } from "./receipts.mjs";

const [id, ...rest] = process.argv.slice(2);
const job = id && jobById(id);

if (!job) {
  console.error(
    [
      "",
      `  usage: pnpm local <${JOB_IDS.join("|")}>`,
      "",
      ...JOB_IDS.map((j) => `    ${j.padEnd(10)} ${jobById(j).title}`),
      "",
      "  pnpm local:status  — when each last succeeded",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logPath = resolve(REPO_ROOT, ".gate", "logs", "local", `${job.id}-${stamp}.log`);

console.log(`\n▶ ${job.title} ${color.dim(`(${job.id})`)}`);
console.log(`  ${color.dim(job.why)}`);
console.log(`  ${color.dim(`log: ${logPath}`)}\n`);

const started = Date.now();
const exitCode = await runTee(job.cmd[0], [...job.cmd.slice(1), ...rest], { logPath });
const durationMs = Date.now() - started;
const ok = exitCode === 0;

recordRun(job.id, {
  ok,
  at: new Date().toISOString(),
  durationMs,
  host: hostname(),
  exitCode,
  log: logPath,
});

console.log(
  `\n  ${ok ? color.green("✓") : color.red("✗")} ${job.id} — ${fmtMs(durationMs)}${ok ? "" : ` (exit ${exitCode})`}`,
);

if (!ok) {
  console.log(`  full output: ${logPath}\n`);
  // Both channels, because the two failure modes are different: the phone
  // catches "started it and walked away", the desktop banner catches "it
  // scrolled off in a tab behind the editor". Neither may fail the task —
  // erroring over your own alerting is how an alert stops being sent at all.
  run("bash", [
    "scripts/local/notify.sh",
    job.urgency,
    `spiralclass: ${job.title} FAILED`,
    `Exit ${exitCode}. Log: ${logPath}`,
  ]);
}

process.exit(exitCode);
