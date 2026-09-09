#!/usr/bin/env node
/**
 * The machine lock (D-146) — one heavy job on this laptop at a time.
 *
 * This exists because the gate stopped being a thing that runs in one place.
 * D-119 moved CI onto the dev machine and D-129 removed every alternative, so
 * the laptop is the only runner; meanwhile the working style became several
 * Claude Code sessions at once, each in its own git worktree, each with its own
 * `.gate/` receipt and its own pre-push hook. Nothing connected them, so N
 * sessions pushing meant N simultaneous gates on a 10-core / 16GB machine.
 *
 * That is not merely slow. Three things collide for real, and two of them
 * corrupt rather than just contend:
 *
 *   1. MEMORY. `next build --turbopack` runs with --max-old-space-size=6144,
 *      and both the integration and E2E suites build. Two at once is a 12GB
 *      ceiling on a machine that is also hosting the editors and the Claude
 *      sessions that started them, and the result is swap, not parallelism.
 *   2. THE TEST DATABASE. apps/web/docker-compose.test.yml pins
 *      `container_name: spiralclass-test-db` on port 5433 — one container for
 *      the whole machine, no matter which worktree booted it. Two integration
 *      runs share a database, and the drift check drops one of its own
 *      (`DROP DATABASE ... WITH (FORCE)`) mid-run. GATE_FRESH_DB=1 takes the
 *      volume out from under the other run entirely.
 *   3. PORT 3000. scripts/ci/e2e.sh serves the built app there and guards the
 *      port precisely because a stray server silently contaminates a run. A
 *      second concurrent E2E either fails that guard or, with
 *      E2E_KILL_PORT_HOG=1, kills the first run's server.
 *
 * Namespacing the container and the port per worktree would fix (2) and (3)
 * and make (1) worse — N Postgres containers and N Next builds is the opposite
 * of what a 16GB box wants. So the answer is the other direction: keep exactly
 * one of each, and serialize access to them.
 *
 * WHY THE LOCK LIVES HERE AND NOT IN .gate/
 * `.gate/` is per-worktree (RECEIPT_DIR resolves relative to this file, which
 * has seven copies). A lock in there would be seven locks, which is no lock.
 * This one is keyed to the machine, under ~/.cache, deliberately outside every
 * checkout.
 *
 * QUEUE, DON'T FAIL. A contended run waits its turn and says whose turn it is
 * waiting for. Failing fast would be cheaper to implement and worse to live
 * with: an unattended agent session that gets refused needs a human to come
 * back and re-run the push, which is exactly the supervision this setup is
 * trying not to need.
 *
 * RE-ENTRANCY. gate.mjs takes the lock and then runs integration.sh and
 * e2e.sh, which take it themselves so that a hand-run
 * (`pnpm test:integration:local`) is serialized too. The token in
 * SPIRALCLASS_LOCK_TOKEN is what stops the child from deadlocking against its
 * own parent.
 *
 * CLI:
 *   node scripts/ci/lock.mjs run --label "integration" -- <cmd> [args...]
 *   node scripts/ci/lock.mjs status
 *
 * API:
 *   const lock = await acquire({ label: "gate · full" });
 *   lock.touch({ step: "e2e" });   // what a waiter sees
 *   lock.release();
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, resolve } from "node:path";

import { color, fmtMs, git } from "./lib.mjs";

/**
 * Machine-scoped, not repo-scoped. SPIRALCLASS_LOCK_DIR overrides it so the
 * tests can exercise the real code against a throwaway directory rather than a
 * mock — a lock is exactly the kind of thing whose bugs only appear when two
 * real processes race for it.
 */
export const LOCK_ROOT =
  process.env.SPIRALCLASS_LOCK_DIR || resolve(homedir(), ".cache", "spiralclass", "machine-lock");

const HOLDER_DIR = resolve(LOCK_ROOT, "holder");
const HOLDER_INFO = resolve(HOLDER_DIR, "info.json");
const QUEUE_DIR = resolve(LOCK_ROOT, "queue");

/** How long a waiter waits before giving up. A full tier is 20-40 min. */
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const POLL_MS = 1500;
/** How often the "still waiting" line reprints. */
const NOTIFY_MS = 30_000;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/** Is a pid still alive? Signal 0 tests for existence without delivering one. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else — alive for our
    // purposes. Only ESRCH is proof of absence.
    return err.code === "EPERM";
  }
}

/**
 * The holder, or null. A holder whose process is gone is not a holder: it is
 * debris from a crash or a hard kill, and leaving it would wedge the machine
 * until someone deleted a directory they don't know exists.
 */
export function currentHolder() {
  if (!existsSync(HOLDER_DIR)) return null;
  const info = readJson(HOLDER_INFO);
  // A holder directory with no readable info.json is mid-acquire (the mkdir
  // landed, the write hasn't) or corrupt. Give the writer a moment before
  // deciding; `since` is unknown either way.
  if (!info) return { pid: null, label: "(unknown)", startedAt: null, incomplete: true };
  if (!pidAlive(info.pid)) {
    rmSync(HOLDER_DIR, { recursive: true, force: true });
    return null;
  }
  return info;
}

/** Live queue entries, oldest first. Dead waiters are swept as we go. */
function queueEntries() {
  if (!existsSync(QUEUE_DIR)) return [];
  const entries = [];
  for (const name of readdirSync(QUEUE_DIR)) {
    const path = resolve(QUEUE_DIR, name);
    const info = readJson(path);
    if (!info || !pidAlive(info.pid)) {
      rmSync(path, { force: true });
      continue;
    }
    entries.push({ ...info, file: name });
  }
  // The filename carries the arrival timestamp, so sorting by name is FIFO.
  return entries.sort((a, b) => a.file.localeCompare(b.file));
}

function describe(info) {
  if (!info) return "nobody";
  const where = info.worktree ? ` in ${color.bold(info.worktree)}` : "";
  const step = info.step ? ` · ${info.step}` : "";
  const age = info.startedAt ? ` (${fmtMs(Date.now() - new Date(info.startedAt).getTime())})` : "";
  return `${info.label}${where}${step}${age}`;
}

/** A short, human name for this checkout — the worktree directory. */
function worktreeName() {
  try {
    const top = git.toplevel?.() || process.cwd();
    return basename(top);
  } catch {
    return basename(process.cwd());
  }
}

/**
 * Take the machine lock, waiting for it if someone else has it.
 *
 * @param {{label?: string, timeoutMs?: number, quiet?: boolean}} [opts]
 * @returns {Promise<{release: () => void, touch: (patch: object) => void, token: string, reentrant: boolean}>}
 */
export async function acquire(opts = {}) {
  const { label = "job", timeoutMs = DEFAULT_TIMEOUT_MS, quiet = false } = opts;

  // Already ours (gate.mjs → integration.sh). Hand back a release that does
  // nothing: the outermost holder owns the lifetime, and a child releasing its
  // parent's lock would hand the machine to a waiter mid-run.
  const inherited = process.env.SPIRALCLASS_LOCK_TOKEN;
  if (inherited) {
    const holder = currentHolder();
    if (holder?.token === inherited) {
      return { release: () => {}, touch: () => {}, token: inherited, reentrant: true };
    }
  }

  mkdirSync(QUEUE_DIR, { recursive: true });
  const token = `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ticketName = `${String(Date.now()).padStart(15, "0")}-${process.pid}.json`;
  const ticketPath = resolve(QUEUE_DIR, ticketName);
  const me = {
    pid: process.pid,
    token,
    label,
    worktree: worktreeName(),
    branch: git.branch(),
    host: hostname(),
    since: new Date().toISOString(),
  };
  writeJson(ticketPath, me);

  const dropTicket = () => rmSync(ticketPath, { force: true });

  const startedWaiting = Date.now();
  let announced = false;
  let lastNotice = 0;

  try {
    for (;;) {
      const holder = currentHolder();
      const queue = queueEntries();
      const position = queue.findIndex((e) => e.file === ticketName);

      // Our turn when nobody holds it and no live waiter arrived first.
      // position === -1 would mean our own ticket was swept as stale, which
      // can only happen if the clock or the pid check misbehaved; treat it as
      // "go", since waiting on a ticket nobody can see is a permanent hang.
      if (!holder && position <= 0) {
        try {
          mkdirSync(HOLDER_DIR, { recursive: false });
        } catch (err) {
          if (err.code === "EEXIST") continue; // lost the race; look again
          throw err;
        }
        const startedAt = new Date().toISOString();
        writeJson(HOLDER_INFO, { ...me, startedAt, step: null });
        dropTicket();

        if (announced && !quiet) {
          console.log(
            `  ${color.green("✓")} machine free after ${fmtMs(Date.now() - startedWaiting)} — starting.\n`,
          );
        }

        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          const held = readJson(HOLDER_INFO);
          // Only tear down a holder that is still ours. If a stale-sweep gave
          // the lock away while we were running, deleting it here would evict
          // whoever legitimately holds it now.
          if (!held || held.token === token) {
            rmSync(HOLDER_DIR, { recursive: true, force: true });
          }
        };
        const touch = (patch) => {
          const held = readJson(HOLDER_INFO);
          if (held?.token === token) writeJson(HOLDER_INFO, { ...held, ...patch });
        };

        // A gate killed with Ctrl-C must not leave the machine locked. These
        // are additive listeners on purpose — gate.mjs installs its own.
        const onExit = () => release();
        process.once("exit", onExit);
        for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
          process.once(sig, () => {
            release();
            process.exit(130);
          });
        }

        return { release, touch, token, reentrant: false };
      }

      if (Date.now() - startedWaiting > timeoutMs) {
        dropTicket();
        throw new Error(
          `timed out after ${fmtMs(timeoutMs)} waiting for the machine lock (held by ${describe(holder)})`,
        );
      }

      if (!quiet && (!announced || Date.now() - lastNotice > NOTIFY_MS)) {
        if (!announced) {
          console.log(`\n  ${color.yellow("machine busy")} — ${describe(holder)}`);
          const ahead = position > 0 ? position : 0;
          if (ahead > 0) {
            console.log(`  ${color.dim(`${ahead} job(s) ahead of you in the queue`)}`);
          }
          console.log(
            `  ${color.dim(`waiting for it (Ctrl-C to abort) · one heavy job at a time is deliberate, see D-146`)}`,
          );
          announced = true;
        } else {
          console.log(
            `  ${color.dim(`still waiting (${fmtMs(Date.now() - startedWaiting)}) — ${describe(holder)}`)}`,
          );
        }
        lastNotice = Date.now();
      }

      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } catch (err) {
    dropTicket();
    throw err;
  }
}

/** Env a child process needs in order to recognise the lock as already ours. */
export function lockEnv(token) {
  return { SPIRALCLASS_LOCK_TOKEN: token };
}

/** One-line summary for `pnpm gate:lock` / the maintenance output. */
export function statusLines() {
  const holder = currentHolder();
  const queue = queueEntries();
  const lines = [];
  lines.push(holder ? `held by  ${describe(holder)}` : "free");
  for (const [i, e] of queue.entries()) {
    lines.push(
      `waiting  #${i + 1} ${e.label} in ${e.worktree} (${fmtMs(Date.now() - new Date(e.since).getTime())})`,
    );
  }
  return lines;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// `run` is what the bash suites use: it owns the acquire/release lifetime, so a
// shell script never has to remember to release on its own error paths.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "status") {
    for (const line of statusLines()) console.log(line);
    process.exit(0);
  }

  if (cmd === "run") {
    const sep = argv.indexOf("--");
    if (sep === -1) {
      console.error("usage: lock.mjs run --label <name> -- <cmd> [args...]");
      process.exit(2);
    }
    const labelIdx = argv.indexOf("--label");
    const label = labelIdx !== -1 && labelIdx < sep ? argv[labelIdx + 1] : "job";
    const cmdArgv = argv.slice(sep + 1);
    if (cmdArgv.length === 0) {
      console.error("lock.mjs run: nothing to run after `--`");
      process.exit(2);
    }

    const lock = await acquire({ label });
    const child = spawn(cmdArgv[0], cmdArgv.slice(1), {
      stdio: "inherit",
      env: { ...process.env, ...lockEnv(lock.token) },
      shell: false,
    });
    child.on("error", (err) => {
      console.error(`lock.mjs: could not run \`${cmdArgv[0]}\`: ${err.message}`);
      lock.release();
      process.exit(127);
    });
    child.on("close", (code) => {
      lock.release();
      process.exit(code ?? 1);
    });
  } else {
    console.error(`lock.mjs: unknown command '${cmd ?? ""}' (want: run | status)`);
    process.exit(2);
  }
}
