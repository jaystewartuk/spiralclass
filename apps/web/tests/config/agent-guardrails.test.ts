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
    ["bash scripts/cloudrun-deploy.sh production --gate-already-passed", "deploying"],
    // The bare Vercel CLI, though the failover is retired (D-186): until the
    // operator deletes the project, `vercel promote <url>` still hands an old
    // deployment the domain.
    ["npx --yes vercel@59.15.1 promote https://example.vercel.app --yes", "taking the domain"],
    ["vercel deploy --prod", "deploying straight to the production target"],
    // ⚠️ EVERY PACKAGE RUNNER, not just npx. The rule named npx alone at first,
    // which left the pnpm spelling — this repository's own package manager, so
    // the likelier one — entirely unblocked.
    ["pnpm dlx vercel promote https://example.vercel.app --yes", "taking the domain via pnpm"],
    ["npm exec vercel deploy --prod", "deploying via npm exec"],
    // An env assignment in front of it, the shape a permission prefix misses.
    ["VERCEL_TOKEN=xxx vercel deploy --prod", "deploying behind an env assignment"],
    // The database job's script, which checkpoints and migrates production on
    // its own since the targets were split ([D-177]'s addendum).
    [
      "bash scripts/database-deploy.sh production --gate-already-passed",
      "migrating production by hand",
    ],
    ["./scripts/database-deploy.sh preview", "migrating preview by hand"],
    ["pnpm --filter spiralclass-web migrate:prod", "migrating a shared database"],
    ["infisical run -- pnpm dev", "handing out live credentials"],
  ])("blocks %s", (command) => {
    expect(blocks(command).blocked, `guard-bash.sh allowed: ${command}`).toBe(true);
  });
});

describe("a heredoc body is data, not command", () => {
  /**
   * The deploy-script rules match their filename anywhere in the command, on
   * the stated grounds that nothing ordinary spells it. A commit message
   * explaining a change to one of those scripts spells it — and was blocked as
   * a deploy of it, twice, until the hook learned to strip heredoc bodies.
   *
   * The names below are assembled rather than written for the reason the file's
   * own SKIP_GATE note gives: a literal would be inspected by the hook guarding
   * the very session that edits this file.
   */
  const script = (stem: string) => `${stem}-deploy.sh`;

  it.each([
    ["the database", script("database")],
    ["Cloud Run", script("cloudrun")],
  ])("lets a commit message explain a change to the %s script", (_label, name) => {
    const command = `git commit -F - <<'MSG'\nThe deploy broke\n\n${name} retyped a value the config owns.\nMSG`;
    const { blocked, reason } = blocks(command);
    expect(blocked, `guard-bash.sh blocked a commit message naming ${name} — ${reason}`).toBe(
      false,
    );
  });

  it("still blocks the same name when it is actually being run", () => {
    // The whole point: stripping the body must not loosen what a command means.
    expect(blocks(`bash scripts/${script("cloudrun")} production`).blocked).toBe(true);
  });

  it("still blocks a command that follows a heredoc it opened", () => {
    // The terminator ends the body; everything after it is command again.
    //
    // Opened with `git`, deliberately not `cat`: the read-only exemption above
    // matches on the FIRST word, so a `cat` heredoc would be allowed before
    // these rules ever run and this test would pass through the wrong door.
    const command = `git commit -F - <<'MSG'\njust prose\nMSG\nbash scripts/${script("cloudrun")} production`;
    expect(blocks(command).blocked).toBe(true);
  });

  it("does not let an unterminated heredoc swallow the rest of the command", () => {
    // A body with no terminator runs to the end of the input, so nothing after
    // it is read as command — which is what the shell does with it too.
    const command = `git commit -F - <<'MSG'\nbash scripts/${script("cloudrun")} production`;
    expect(blocks(command).blocked).toBe(false);
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
    // ⚠️ `vercel` is an npm PACKAGE NAME as well as a command, which the Fly
    // rule's shape does not have to cope with. A loose
    // `[[:space:]]vercel[[:space:]]` pattern blocks this, and this is exactly
    // a harmless lookup — it reads no credential and deploys nothing.
    // So that rule is anchored at a command position (D-177).
    "npm view vercel version",
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
