// Where a hand-run maintenance task records that it happened (D-129).
//
// Gitignored, under the same `.gate/` directory as the gate receipt and the
// release ledger, and for the same reason: it describes what THIS machine did.
// A clone on another box says "no record", never "never ran".

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { RECEIPT_DIR } from "../ci/lib.mjs";

export const JOB_LOG_PATH = resolve(RECEIPT_DIR, "local-jobs.json");

/** @typedef {{ok: boolean, at: string, durationMs: number, host: string, exitCode: number, log: string}} Run */

/** @returns {Record<string, {last: Run, lastOk: Run | null}>} */
export function readRuns() {
  try {
    const parsed = JSON.parse(readFileSync(JOB_LOG_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Missing or corrupt reads as empty. This file is an aid to the operator;
    // it must never be the thing that fails a task.
    return {};
  }
}

/**
 * Record one run. Keeps the last run AND the last successful one separately —
 * a red run must not reset the staleness clock, or a task that has been failing
 * for a fortnight reads as fresh.
 * @param {string} id
 * @param {Run} run
 */
export function recordRun(id, run) {
  const all = readRuns();
  const prev = all[id];
  all[id] = { last: run, lastOk: run.ok ? run : (prev?.lastOk ?? null) };
  mkdirSync(RECEIPT_DIR, { recursive: true });
  writeFileSync(JOB_LOG_PATH, `${JSON.stringify(all, null, 2)}\n`);
}

/** Hours since an ISO timestamp, or null when there isn't one. */
export function hoursSince(iso) {
  if (!iso) return null;
  const then = Date.parse(iso);
  return Number.isNaN(then) ? null : (Date.now() - then) / 3_600_000;
}

export function fmtAge(hours) {
  if (hours === null) return "never";
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
