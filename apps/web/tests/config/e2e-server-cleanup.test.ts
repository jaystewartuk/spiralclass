import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

// Locks the way scripts/ci/e2e.sh stops the app it started.
//
// The script serves the suite from `pnpm exec next start`, launched inside a
// `( cd apps/web; ... ) &` subshell. That makes next-server — the process that
// actually binds port 3000 — a GRANDCHILD, while `$!` is only the wrapper. The
// original cleanup killed `$APP_PID` alone, which reaped the wrapper instantly
// and left the listener running for the rest of the machine's uptime.
//
// The damage lands on the NEXT run, not this one, which is what made it hard to
// read: e2e.sh's own port guard trips at startup and reports "Port 3000 is
// already in use", so the run looks like it was sabotaged by a stray dev server
// someone forgot to close. It wasn't — the previous e2e run leaked its own
// server. Observed three times in one session, each time failing a `git push`
// because the pre-push hook's gate could not get the port. The documented
// workaround, E2E_KILL_PORT_HOG=1, papers over a leak instead of closing it.
//
// The fix is to put the job in its own process group (`set -m`, so pgid == $!)
// and signal the whole group on the way out (`kill -- -$APP_PID`). Both halves
// are load-bearing and neither is self-evident to a later reader:
//
//   * Drop `set -m` and the job inherits the SCRIPT's process group, so
//     `kill -- -$APP_PID` either errors or — much worse — signals the entire
//     gate run that invoked e2e.sh.
//   * Keep `set -m` but signal the bare PID and the grandchild survives again,
//     silently, exactly as before.
//
// Nothing else in the repo would catch a regression here: the script is not
// type-checked, not linted for semantics, and a run that leaks still exits 0
// and reports a green suite. The cost only appears on someone else's next
// command. Hence a text-level guard on the two constructs.
const E2E_SH = readFileSync(resolve(REPO_ROOT, "scripts/ci/e2e.sh"), "utf8");

describe("scripts/ci/e2e.sh — app teardown", () => {
  it("starts the app under job control so it gets its own process group", () => {
    // `set -m` must appear before the backgrounded subshell that starts the app.
    const setM = E2E_SH.indexOf("\nset -m");
    const start = E2E_SH.indexOf('pnpm exec next start -p "$PORT"');

    expect(setM, "e2e.sh no longer enables job control (set -m)").toBeGreaterThan(-1);
    expect(start, "e2e.sh no longer starts the app with `next start`").toBeGreaterThan(-1);
    expect(setM, "`set -m` must come before the app is backgrounded").toBeLessThan(start);
  });

  it("signals the whole process group on cleanup, not just the wrapper PID", () => {
    // The negative-PID form is the entire point: it reaches next-server, which
    // is a grandchild of $APP_PID and survives a signal sent to $APP_PID alone.
    expect(
      E2E_SH,
      "cleanup must kill the process GROUP (kill -- -$APP_PID); killing $APP_PID " +
        "alone leaves next-server holding the port for the next run",
    ).toContain('kill -- -"$APP_PID"');
  });

  it("escalates to SIGKILL rather than exiting with the port still held", () => {
    // A TERM the server ignores would hand the next run the exact failure this
    // cleanup exists to prevent, so the script must not simply give up.
    expect(E2E_SH, "cleanup must escalate to SIGKILL if the group outlives TERM").toContain(
      'kill -9 -- -"$APP_PID"',
    );
  });

  it("still fails fast on a port hog it did not start", () => {
    // The guard that reports a foreign process on the port stays: this fix
    // removes the script's own leak, it does not make the script safe to run
    // against someone else's server. Auto-kill remains opt-in and cwd-scoped.
    expect(E2E_SH).toContain("E2E_KILL_PORT_HOG");
    expect(E2E_SH).toContain("Port ${PORT} is already in use by pid");
  });

  it("scopes the auto-kill to EVERY worktree of this repo, not just the current one", () => {
    // `git rev-parse --show-toplevel` inside a worktree is that worktree, so
    // scoping to it meant E2E_KILL_PORT_HOG could only ever reach a stray
    // started from the same checkout. D-146 has several sessions working this
    // repo at once in separate worktrees on one laptop, so the port-3000
    // collision that actually occurs is between SIBLINGS — the one case the
    // escape hatch could not reach. Observed 2026-09-01: three consecutive
    // ship:preview runs died here, the last two with the flag set.
    expect(
      E2E_SH,
      "the port-hog check must enumerate worktrees, not just --show-toplevel",
    ).toContain("git worktree list --porcelain");
    // Precisely the old construct, not `--show-toplevel` in general: the
    // script legitimately uses that at the top to cd to the repo root, and a
    // blanket ban would fail on the line that is still correct.
    expect(
      E2E_SH,
      "the port-hog check must not resolve a single repo_root the way it used to",
    ).not.toContain('repo_root="$(git rev-parse --show-toplevel)"');
  });

  it("names the worktree the port hog belongs to", () => {
    // Widening the scope does NOT make killing safe: the process may belong to
    // a live session mid-task. On 2026-09-01 one was killed on the assumption
    // it was abandoned, and the owning session started a new one six minutes
    // later. Naming the owner is what lets a reader tell "my leftover" from
    // "someone else's work in progress" before reaching for the flag.
    expect(E2E_SH).toContain("the main checkout");
    expect(E2E_SH).toContain("worktree");
    expect(E2E_SH, "the refusal must say who owns it").toContain("quite possibly another session");
  });

  it("refuses to kill a process outside this repo even with the flag set", () => {
    // A dev server for an unrelated project on a shared machine must never be
    // killed by this script, flag or no flag.
    expect(E2E_SH).toContain("It is NOT one of this repo's worktrees");
  });
});
