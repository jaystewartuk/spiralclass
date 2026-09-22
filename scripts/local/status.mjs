#!/usr/bin/env node
/**
 * When did each hand-run maintenance task last succeed? (D-129)
 *
 *   pnpm local:status
 *
 * This is the whole answer to the objection that kept these tasks on a GitHub
 * Actions cron: a job that silently didn't run is indistinguishable from one
 * that did. On Actions the distinguisher was a run history nobody looked at and
 * a failure email that arrives only when the job actually ran. Here it is a
 * receipt on disk, read back at a moment the operator is provably present.
 *
 * `staleWarnings()` is the same data as one line per overdue task; the gate
 * prints it after every run, which the pre-push hook triggers on every push.
 * That is the mechanism — this command is for looking on purpose.
 *
 * Exits 1 when anything is overdue or last ran red, so it composes.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { color } from "../ci/lib.mjs";
import { JOBS } from "./jobs.mjs";
import { fmtAge, hoursSince, readRuns } from "./receipts.mjs";

/**
 * @returns {Array<{job: import("./jobs.mjs").Job, ageHours: number|null, stale: boolean, lastRed: boolean}>}
 */
export function jobStates() {
  const runs = readRuns();
  return JOBS.map((job) => {
    const record = runs[job.id];
    const ageHours = hoursSince(record?.lastOk?.at);
    return {
      job,
      record,
      ageHours,
      // Never having run counts as stale. The failure this whole mechanism
      // exists for started as "nobody has done this yet", not as a lapse.
      stale: ageHours === null || ageHours > job.staleAfterHours,
      lastRed: Boolean(record?.last && !record.last.ok),
    };
  });
}

/**
 * One short line per task that is overdue or last ran red — nothing at all when
 * everything is current. Printed by the gate, so it has to stay quiet in the
 * normal case or it becomes a banner nobody reads.
 * @returns {string[]}
 */
export function staleWarnings() {
  return jobStates()
    .filter((s) => s.stale || s.lastRed)
    .map(({ job, record, ageHours, lastRed }) => {
      const state = lastRed
        ? `last run FAILED (${fmtAge(hoursSince(record.last.at))})`
        : `last green ${fmtAge(ageHours)}`;
      return `${job.id.padEnd(10)} ${state}  →  pnpm local ${job.id}`;
    });
}

function main() {
  const states = jobStates();
  console.log("\n  Hand-run maintenance (D-129) — nothing runs these but you.\n");
  for (const { job, record, ageHours, stale, lastRed } of states) {
    const mark = stale ? color.yellow("!") : color.green("✓");
    const green = ageHours === null ? "never run" : `last green ${fmtAge(ageHours)}`;
    console.log(`  ${mark} ${color.bold(job.id.padEnd(10))} ${green}`);
    console.log(`    ${color.dim(job.title)}`);
    console.log(`    ${color.dim(job.why)}`);
    if (lastRed) {
      console.log(
        `    ${color.red(`last run failed (exit ${record.last.exitCode})`)} ${color.dim(record.last.log)}`,
      );
    }
    console.log(
      `    ${color.dim(`run it: pnpm local ${job.id}   ·  warns after ${Math.round(job.staleAfterHours / 24)}d`)}\n`,
    );
  }
  const bad = states.filter((s) => s.stale || s.lastRed);
  if (bad.length === 0) console.log(`  ${color.green("all current")}\n`);
  return bad.length === 0 ? 0 : 1;
}

// Only act as a CLI when invoked directly — the gate imports staleWarnings().
// Compared by resolved path, not by filename: scripts/ci/status.mjs is also
// called `status.mjs`, and a suffix check would fire this one from inside it.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
