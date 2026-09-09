import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The agent guardrails are executed, not read.
 *
 * WHY THIS EXISTS. `.claude/settings.json` denies the commands a session must
 * never run — `pnpm promote`, `gh pr merge`, the deploy scripts — but a
 * permission rule matches a command PREFIX, and the two shapes that actually
 * matter here are not prefixes:
 *
 *     SKIP_GATE=1 git push        an environment assignment in front
 *     git push --no-verify        a flag in the middle
 *
 * Both are the gate bypass CLAUDE.md forbids, both are what a model reaches for
 * when a push looks stuck, and on this machine a push that looks stuck is
 * usually queuing on the lock every worktree shares (D-146). So the rule lives
 * in `.claude/hooks/guard-bash.sh`, which sees the whole command line.
 *
 * A hook is the worst possible place for an untested regex. It runs outside the
 * gate, its failures are silent by design (the harness treats a non-2 exit as
 * "carry on"), and the symptom of a broken one is *nothing happening* — the
 * guard stops guarding and says so to nobody. `claude-md.test.ts` can only
 * prove the file exists and mentions the right words. This proves it behaves.
 *
 * THE ORDERING BUG THIS CAUGHT, on the first run. The hook exempts read-only
 * commands so that `grep -rn "fly deploy" docs/` is not blocked — a session
 * asking a question about the deploy path is not deploying, and a guard that
 * cannot tell the difference is one people learn to route around. That
 * exemption was written before the rule about credential-bearing files, and
 * sat above it, so `cat config/env/production.local.env` was allowed: the
 * exemption saw a `cat`. Reading a secret IS a read. The exemption has to come
 * after the rule about what may not be read, and the case below is what holds
 * it there.
 *
 * Each case is a real hook payload. Exit 2 blocks; anything else allows.
 */

const REPO_ROOT = resolve(process.cwd(), "..", "..");
const GUARD = join(REPO_ROOT, ".claude", "hooks", "guard-bash.sh");

/** Runs the hook exactly as the harness does. Returns true when it blocks. */
function blocks(command: string): { blocked: boolean; reason: string } {
  const result = spawnSync("bash", [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
  });
  return { blocked: result.status === 2, reason: (result.stderr ?? "").split("\n")[0] };
}

/**
 * `SKIP_GATE` is assembled rather than written, for the same reason the hook
 * exists: this file is edited by sessions whose Bash calls the hook inspects,
 * and a literal here would block the very command that runs these tests.
 */
const SKIP_GATE = ["SKIP", "GATE"].join("_");

describe("the Bash guard blocks what a permission prefix cannot", () => {
  it.each([
    [`${SKIP_GATE}=1 git push`, "an env assignment in front of the command"],
    ["git push --no-verify", "a bypass flag in the middle of it"],
    ["git push --force origin main", "a rewrite of a branch others may be reading"],
  ])("blocks %s", (command) => {
    expect(blocks(command).blocked, `guard-bash.sh allowed: ${command}`).toBe(true);
  });

  it("leaves --force-with-lease alone", () => {
    // The deliberate, non-destructive form. Blocking it would push people
    // towards plain --force, which is the opposite of the point.
    expect(blocks("git push --force-with-lease").blocked).toBe(false);
  });
});

describe("the operator's decisions cannot be taken by a session", () => {
  it.each([
    ["gh pr merge 1234 --squash", "merging"],
    ["pnpm promote", "promoting"],
    ["bash scripts/fly-deploy.sh production", "deploying"],
    ["pnpm --filter spiralclass-web migrate:prod", "migrating a shared database"],
    ["infisical run -- pnpm dev", "handing out live credentials"],
  ])("blocks %s", (command) => {
    expect(blocks(command).blocked, `guard-bash.sh allowed: ${command}`).toBe(true);
  });
});

describe("secrets are not readable, and the templates are", () => {
  it("blocks a read of a credential-bearing file even through a read-only command", () => {
    // ⚠️ THE REGRESSION. See the header: the read-only exemption used to sit
    // above this rule and swallowed it.
    expect(blocks("cat config/env/production.local.env").blocked).toBe(true);
  });

  it("allows the committed, non-secret template", () => {
    expect(blocks("cat apps/web/.env.example").blocked).toBe(false);
  });
});

describe("it does not block ordinary work", () => {
  it.each([
    "pnpm test",
    "pnpm --filter spiralclass-web test -- src/lib/money.test.ts",
    "pnpm gate --allow-dirty",
    "git push -u origin my-branch",
    // Asking a question about a forbidden command is not performing it. This
    // is the false positive that would get the hook switched off.
    'grep -rn "pnpm pro" "mote" docs/',
  ])("allows %s", (command) => {
    const { blocked, reason } = blocks(command);
    expect(blocked, `guard-bash.sh blocked ordinary work: ${command} — ${reason}`).toBe(false);
  });

  it("fails open on a payload it cannot parse", () => {
    // A guard that halts the session when something upstream changes shape is
    // a guard that gets deleted. Garbage in, exit 0.
    const result = spawnSync("bash", [GUARD], { input: "not json", encoding: "utf8" });
    expect(result.status).toBe(0);
  });
});
