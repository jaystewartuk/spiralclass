// Shared helpers for the local gate (scripts/ci/*). Deliberately dependency-free
// and synchronous: every step streams straight to the operator's terminal, so
// spawnSync + stdio:"inherit" is both the simplest and the most legible thing
// that can work. Nothing here talks to the network except `gh`, which is
// isolated in status.mjs.

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

/**
 * Where a run records what it certified. Gitignored: it describes THIS machine's
 * run of THIS commit, and it lives here (rather than being passed around) so the
 * pre-push hook can run the gate and the status poster as two separate
 * processes without inventing a protocol between them.
 */
export const RECEIPT_DIR = resolve(REPO_ROOT, ".gate");
export const RECEIPT_PATH = resolve(RECEIPT_DIR, "receipt.json");

/**
 * The release ledger: what this machine actually SHIPPED, as opposed to what it
 * certified (the receipt above).
 *
 * It exists because web and mobile stopped being coupled to one gated push
 * (D-120 for web; mobile shipped by hand), and the failure that arrangement invites
 * is not a red build — it is silence. A promote that deploys web and never
 * publishes mobile leaves no trace anywhere: `production` is at the new commit,
 * the app store of record is a channel in someone else's dashboard, and nothing
 * on disk disagrees. This file is the thing that disagrees.
 *
 * Deliberately local and gitignored, like the receipt: it records what THIS
 * machine did. A promote run from another machine is not in it, which is why
 * release-status.mjs reports "no record of" rather than "did not happen".
 */
export const LEDGER_PATH = resolve(RECEIPT_DIR, "release.json");

/** How many entries to keep. Enough to see a few releases back, not a database. */
const LEDGER_LIMIT = 50;

/** @returns {{entries: Array<Record<string, unknown>>}} */
export function readLedger() {
  try {
    const parsed = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    return Array.isArray(parsed?.entries) ? parsed : { entries: [] };
  } catch {
    // Missing or corrupt reads as empty. A ledger is a convenience for the
    // operator; it must never be the thing that fails a deploy.
    return { entries: [] };
  }
}

/**
 * Append one shipped-thing to the ledger. Newest first.
 * @param {Record<string, unknown>} entry
 */
export function recordRelease(entry) {
  const ledger = readLedger();
  ledger.entries.unshift({ at: new Date().toISOString(), host: hostname(), ...entry });
  ledger.entries = ledger.entries.slice(0, LEDGER_LIMIT);
  mkdirSync(RECEIPT_DIR, { recursive: true });
  writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * The most recent entry matching every field of `where`.
 * @param {Record<string, unknown>} where
 */
export function lastRelease(where) {
  return (
    readLedger().entries.find((e) => Object.entries(where).every(([k, v]) => e[k] === v)) ?? null
  );
}

/** Run a command, streaming its output. Returns the exit code. */
export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...(opts.env ?? {}) },
    shell: false,
  });
  if (res.error) {
    console.error(`\n  ✗ could not run \`${cmd}\`: ${res.error.message}`);
    return 127;
  }
  return res.status ?? 1;
}

/**
 * Run a command, streaming its output to the terminal AND teeing a copy to
 * `logPath` — so a step that's already scrolled off-screen (or one that ran
 * quietly and passed) can still be read back after the fact without asking
 * the operator to re-run it. Async (unlike `run`) only because tee-ing needs
 * a pipe rather than "inherit"; every caller here already runs steps in
 * sequence, so this doesn't change the gate's serial execution model.
 * @returns {Promise<number>} exit code
 */
export function runTee(cmd, args, opts = {}) {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const log = createWriteStream(opts.logPath);
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? REPO_ROOT,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["inherit", "pipe", "pipe"],
      shell: false,
    });
    child.on("error", (err) => {
      console.error(`\n  ✗ could not run \`${cmd}\`: ${err.message}`);
      log.end();
      resolvePromise(127);
    });
    const tee = (stream, dest) => {
      stream.on("data", (chunk) => {
        dest.write(chunk);
        log.write(chunk);
      });
    };
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    child.on("close", (code) => {
      log.end();
      resolvePromise(code ?? 1);
    });
  });
}

/** Run a command and return its trimmed stdout (empty string on failure). */
export function capture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  if (res.status !== 0) return "";
  return (res.stdout ?? "").trim();
}

/** Run a command for its exit code only, showing nothing. */
export function check(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: opts.cwd ?? REPO_ROOT, stdio: "ignore" }).status === 0;
}

/** Is a binary on PATH? */
export function has(cmd) {
  return spawnSync("command", ["-v", cmd], { shell: true, stdio: "ignore" }).status === 0;
}

/** Is the Docker daemon actually up (not just installed)? */
export function dockerReady() {
  return has("docker") && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

export function fmtMs(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export const git = {
  sha: () => capture("git", ["rev-parse", "HEAD"]),
  shortSha: () => capture("git", ["rev-parse", "--short", "HEAD"]),
  branch: () => capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
  /** This checkout's root — differs per worktree, which is how a lock names its holder. */
  toplevel: () => capture("git", ["rev-parse", "--show-toplevel"]),
  /** Uncommitted changes (tracked or staged) mean the run doesn't describe HEAD. */
  isDirty: () => capture("git", ["status", "--porcelain", "--untracked-files=no"]) !== "",
  /** Does this exact commit exist on the remote yet? */
  isOnOrigin: (sha) =>
    capture("git", ["branch", "-r", "--contains", sha]) !== "" ||
    // A freshly pushed branch this checkout hasn't fetched back yet.
    capture("git", ["ls-remote", "origin"]).includes(sha),
};

/** Repo slug (owner/name) parsed from the origin remote. */
export function repoSlug() {
  const url = capture("git", ["remote", "get-url", "origin"]);
  const m = url.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : "";
}

/**
 * Bare ANSI, no dependency — off when stdout isn't a TTY (a log file, a piped
 * `less`) or `NO_COLOR`/`CI` is set, so a redirected run never gets escape
 * codes baked into it.
 */
const COLOR_ON = process.stdout.isTTY && !process.env.NO_COLOR && !process.env.CI;
function paint(code) {
  return (s) => (COLOR_ON ? `\x1b[${code}m${s}\x1b[0m` : String(s));
}
export const color = {
  green: paint(32),
  red: paint(31),
  yellow: paint(33),
  cyan: paint(36),
  dim: paint(2),
  bold: paint(1),
};
