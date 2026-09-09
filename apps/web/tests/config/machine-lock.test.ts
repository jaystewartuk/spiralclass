import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// The machine lock (D-146) is the thing that lets several Claude Code sessions
// share one laptop. Its guards in local-gate.test.ts read the SOURCE — that the
// gate calls acquire, that the suites take it themselves — which is the right
// check for "did someone unpick the wiring" and the wrong one for "does it
// actually work". A lock that never excludes and a lock that deadlocks both
// pass a source read.
//
// So these run real processes and assert on observed behaviour. Two failure
// modes are worth the seconds they cost, because both are silent and both are
// expensive:
//
//   1. It doesn't exclude. Two integration runs then share the fixed-name
//      `spiralclass-test-db` container and drop each other's drift database
//      mid-check — which surfaces days later as flakiness, not as a lock bug.
//   2. It excludes forever. A gate killed by Ctrl-C or the OOM killer leaves a
//      holder behind with no handler able to run; if that were permanent, every
//      other session would hang until someone found a directory under ~/.cache
//      they had no reason to know about.
//
// Vitest runs from the package root (apps/web).
const repoRoot = resolve(process.cwd(), "..", "..");
const LOCK = join(repoRoot, "scripts", "ci", "lock.mjs");

const tempDirs: string[] = [];
const makeLockDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "spiralclass-lock-test-"));
  tempDirs.push(dir);
  return dir;
};

/** SPIRALCLASS_LOCK_DIR is why these can exercise the real code, not a mock. */
const envFor = (lockDir: string) => ({
  ...process.env,
  SPIRALCLASS_LOCK_DIR: lockDir,
  // The child must not inherit a token from a gate that is running this suite,
  // or every acquire below would pass straight through as re-entrant.
  SPIRALCLASS_LOCK_TOKEN: "",
  SPIRALCLASS_LOCK_INNER: "",
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      spawnSync("rm", ["-rf", dir]);
    } catch {
      /* a leaked temp dir is not worth failing a test over */
    }
  }
});

describe("the machine lock excludes", () => {
  it("serializes concurrent holders — no two overlap", async () => {
    const lockDir = makeLockDir();
    const out = join(lockDir, "intervals.jsonl");
    writeFileSync(out, "");

    // Synchronous busy-wait on purpose: the real workloads burn CPU, and a
    // setTimeout would let the event loop interleave and hide a broken lock.
    const worker = join(lockDir, "worker.mjs");
    writeFileSync(
      worker,
      [
        'import { appendFileSync } from "node:fs";',
        "const [id, out] = process.argv.slice(2);",
        "const start = Date.now();",
        "while (Date.now() < start + 300) {}",
        'appendFileSync(out, JSON.stringify({ id, start, end: Date.now() }) + "\\n");',
      ].join("\n"),
    );

    const race = ["a", "b", "c"].map(
      (id) =>
        new Promise<number>((res) => {
          const child = spawn(
            "node",
            [LOCK, "run", "--label", `race-${id}`, "--", "node", worker, id, out],
            { env: envFor(lockDir), stdio: "ignore" },
          );
          child.on("close", (code) => res(code ?? 1));
        }),
    );

    expect(await Promise.all(race)).toEqual([0, 0, 0]);

    const intervals = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; start: number; end: number })
      .sort((x, y) => x.start - y.start);

    expect(intervals).toHaveLength(3);
    for (let i = 1; i < intervals.length; i++) {
      // The actual invariant: nobody starts before their predecessor finished.
      expect(
        intervals[i].start,
        `${intervals[i].id} started while ${intervals[i - 1].id} still held the machine`,
      ).toBeGreaterThanOrEqual(intervals[i - 1].end);
    }
  }, 30_000);

  it("lets a child of the holder pass straight through", async () => {
    // gate.mjs holds the lock and then runs integration.sh, which takes it
    // too. Without re-entrancy that is a guaranteed deadlock, and it would
    // deadlock the FULL tier specifically — the run nobody wants to discover
    // is broken at promote time.
    const lockDir = makeLockDir();
    const inner = join(lockDir, "inner.mjs");
    writeFileSync(inner, 'console.log("inner ran");');

    const outer = join(lockDir, "outer.mjs");
    writeFileSync(
      outer,
      [
        'import { spawnSync } from "node:child_process";',
        `import { acquire, lockEnv } from ${JSON.stringify(LOCK)};`,
        'const lock = await acquire({ label: "outer", quiet: true });',
        "const res = spawnSync(process.execPath, [",
        `  ${JSON.stringify(LOCK)}, "run", "--label", "inner", "--", process.execPath, ${JSON.stringify(inner)},`,
        '], { env: { ...process.env, ...lockEnv(lock.token) }, encoding: "utf8", timeout: 15000 });',
        "lock.release();",
        'process.stdout.write(res.stdout ?? "");',
        "process.exit(res.status === 0 ? 0 : 1);",
      ].join("\n"),
    );

    const res = spawnSync("node", [outer], {
      env: envFor(lockDir),
      encoding: "utf8",
      timeout: 25_000,
    });

    expect(res.stdout).toContain("inner ran");
    expect(res.status).toBe(0);
  }, 30_000);
});

describe("the machine lock releases", () => {
  it("sweeps a holder that was SIGKILLed without releasing", async () => {
    // No exit handler runs on SIGKILL, so this is the OOM-killer case exactly.
    const lockDir = makeLockDir();
    const sleeper = join(lockDir, "sleeper.mjs");
    writeFileSync(sleeper, "setTimeout(() => {}, 60000);");

    const doomed = spawn("node", [LOCK, "run", "--label", "doomed", "--", "node", sleeper], {
      env: envFor(lockDir),
      stdio: "ignore",
      detached: true,
    });

    // Wait for the lock to actually be held, rather than guessing a delay.
    const holderDir = join(lockDir, "holder");
    for (let i = 0; i < 100 && !existsSync(holderDir); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(holderDir), "the lock was never taken, so this proves nothing").toBe(true);

    try {
      process.kill(-doomed.pid!, "SIGKILL");
    } catch {
      process.kill(doomed.pid!, "SIGKILL");
    }
    await new Promise((r) => setTimeout(r, 300));

    // The corpse is still on disk; the next acquirer has to reason about it.
    expect(existsSync(holderDir)).toBe(true);

    const next = spawnSync("node", [LOCK, "run", "--label", "next", "--", "node", "-e", "0"], {
      env: envFor(lockDir),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(next.status, `stuck behind a dead holder: ${next.stderr}`).toBe(0);
  }, 30_000);

  it("reports who holds the machine", () => {
    // The queue output is what turns "my push is hanging" into "another
    // session is running the full tier". If it regresses to silence, the
    // lock's worst property becomes indistinguishable from a bug.
    const lockDir = makeLockDir();
    const free = spawnSync("node", [LOCK, "status"], {
      env: envFor(lockDir),
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(free.status).toBe(0);
    expect(free.stdout).toContain("free");
  }, 20_000);
});
