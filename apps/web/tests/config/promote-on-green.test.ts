import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_ROLE_ID, PRODUCTION_REF } from "../../../../scripts/ci/deploy-protection.mjs";
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

/**
 * A merge to `main` starts its own production deploy ([D-199]).
 *
 * promote-on-green.yml runs `scripts/ci/promote.mjs --when-certified` each time
 * Gate or Heavy finishes green on a push to `main`. It fires twice per merge, so
 * the first run normally finds the other workflow still going — and that has to
 * be a quiet hold, not a red run and never a push. Everything else promote
 * refuses must stay a refusal.
 *
 * So the first half of this file runs the real promote.mjs against a throwaway
 * repository, with a stub `gh` answering the protection settings and the
 * runners' verdict, and reads what happened to `production` on its origin. The
 * second half holds the workflow to the shape its header describes.
 */

const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

// The live settings promote reads before it moves anything — the passing shape
// from production-access.test.ts, as `gh api` would return it.
const historyRuleset = {
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: [PRODUCTION_REF], exclude: [] } },
  rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
  bypass_actors: [],
};
const PROTECTED = {
  environment: {
    can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    protection_rules: [
      { type: "branch_policy" },
      { type: "required_reviewers", prevent_self_review: false, reviewers: [{}] },
    ],
  },
  policies: { branch_policies: [{ name: "production" }] },
  rulesets: {
    "1": historyRuleset,
    "2": {
      ...historyRuleset,
      rules: [{ type: "update" }],
      bypass_actors: [
        { actor_id: ADMIN_ROLE_ID, actor_type: "RepositoryRole", bypass_mode: "always" },
      ],
    },
  },
};

// Answers exactly the calls promote makes, from STUB_* variables, and fails
// anything else so a new call shows up here rather than passing by accident.
const STUB_GH = `#!/usr/bin/env node
const [cmd, path] = process.argv.slice(2);
const say = (value) => { process.stdout.write(typeof value === "string" ? value : JSON.stringify(value)); process.exit(0); };
const settings = JSON.parse(process.env.STUB_SETTINGS);
if (cmd === "api") {
  if (path === "repos/{owner}/{repo}/environments/production") say(settings.environment);
  if (path.endsWith("/deployment-branch-policies")) say(settings.policies);
  if (path === "repos/{owner}/{repo}/rulesets") say(Object.keys(settings.rulesets).map((id) => ({ id })));
  const ruleset = path.match(/rulesets\\/(\\d+)$/);
  if (ruleset) say(settings.rulesets[ruleset[1]]);
  // Already in the shape promote's --jq filter produces.
  if (path.startsWith("repos/{owner}/{repo}/actions/runs?")) say(process.env.STUB_RUNS);
}
if (cmd === "repo") say("owner/repo");
if (cmd === "release") process.exit(0);
process.stderr.write("stub gh: unexpected call " + process.argv.slice(2).join(" "));
process.exit(1);
`;

const run = (name: string, conclusion: string | null, status = "completed") => ({
  name,
  status,
  conclusion,
  created_at: "2026-10-14T10:00:00Z",
});

let dir: string;
let work: string;
let origin: string;
let env: NodeJS.ProcessEnv;

const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: work, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const originProduction = () =>
  spawnSync("git", ["rev-parse", "production"], {
    cwd: origin,
    env,
    encoding: "utf8",
  }).stdout.trim();

function promote(args: string[], runs: unknown[], settings: unknown = PROTECTED) {
  return spawnSync(process.execPath, ["scripts/ci/promote.mjs", ...args], {
    cwd: work,
    env: { ...env, STUB_RUNS: JSON.stringify(runs), STUB_SETTINGS: JSON.stringify(settings) },
    encoding: "utf8",
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "promote-on-green-"));
  work = join(dir, "work");
  origin = join(dir, "origin.git");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), STUB_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const gitconfig = join(dir, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = Test\n\temail = test@example.invalid\n");
  // ⚠️ Every inherited GIT_* variable is dropped. The pre-push hook runs this
  // suite with GIT_DIR exported, and a `git init` that inherits it re-initialises
  // the REAL repository instead of this one, writing to its config.
  env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: dir,
  });

  spawnSync("git", ["init", "--quiet", "--bare", "-b", "main", origin], { env });
  mkdirSync(work);
  git("init", "--quiet", "-b", "main");
  // Refuse to go on unless git now means the throwaway repository.
  expect(git("rev-parse", "--absolute-git-dir")).toBe(join(realpathSync(work), ".git"));
  git("remote", "add", "origin", origin);
  // promote.mjs and what it imports, resolved from its own location, so the
  // copy runs against this repository rather than the real one.
  for (const file of ["promote.mjs", "lib.mjs", "deploy-protection.mjs", "deploy-verdict.mjs"]) {
    cpSync(join(REPO_ROOT, "scripts", "ci", file), join(work, "scripts", "ci", file));
  }
  cpSync(
    join(REPO_ROOT, "scripts", "local", "receipts.mjs"),
    join(work, "scripts", "local", "receipts.mjs"),
  );
  cpSync(
    join(REPO_ROOT, ".github", "workflows", "deploy-production.yml"),
    join(work, ".github", "workflows", "deploy-production.yml"),
  );
  writeFileSync(join(work, ".gitignore"), ".gate/\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "shipped");
  git("push", "--quiet", "origin", "HEAD:main", "HEAD:production");
  writeFileSync(join(work, "change.txt"), "merged\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "merged");
  git("push", "--quiet", "origin", "HEAD:main");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("promote --when-certified", () => {
  const ARGS = ["--when-certified", "--yes", "--no-wait"];

  it("ships when both runners are green", () => {
    const result = promote(ARGS, [run("Gate", "success"), run("Heavy", "success")]);
    expect(result.status, result.stderr).toBe(0);
    expect(originProduction()).toBe(git("rev-parse", "HEAD"));
  });

  it.each([
    [
      "Heavy still running — the first of the two runs, every merge",
      run("Heavy", null, "in_progress"),
    ],
    ["Heavy cancelled by a newer push", run("Heavy", "cancelled")],
    ["Heavy red", run("Heavy", "failure")],
  ])("holds without pushing: %s", (_, heavy) => {
    const shipped = originProduction();
    const result = promote(ARGS, [run("Gate", "success"), heavy]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Holding");
    expect(originProduction()).toBe(shipped);
  });

  it("holds when production already carries the commit — the second of two runs", () => {
    git("push", "--quiet", "origin", "HEAD:production");
    const result = promote(ARGS, [run("Gate", "success"), run("Heavy", "success")]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("already carries");
  });

  it("still refuses, red, when production is not protected", () => {
    const shipped = originProduction();
    const result = promote(ARGS, [run("Gate", "success"), run("Heavy", "success")], {
      ...PROTECTED,
      environment: { ...PROTECTED.environment, protection_rules: [] },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no required reviewer");
    expect(originProduction()).toBe(shipped);
  });

  it("still refuses, red, a commit that is not on main", () => {
    writeFileSync(join(work, "unmerged.txt"), "branch\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "never merged");
    const result = promote(ARGS, [run("Gate", "success"), run("Heavy", "success")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not on origin/main");
  });

  it("without the flag, an uncertified commit is still a refusal", () => {
    const result = promote(
      ["--yes", "--no-wait"],
      [run("Gate", "success"), run("Heavy", null, "in_progress")],
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not certified");
  });
});

describe("promote-on-green.yml", () => {
  const workflow = read(".github", "workflows", "promote-on-green.yml");

  it("fires when Gate or Heavy finishes on main, and on nothing else", () => {
    const on = workflow.split(/^on:$/m)[1]?.split(/^\S/m)[0] ?? "";
    expect(on).toMatch(
      /workflow_run:\n\s+workflows: \[Gate, Heavy\]\n\s+types: \[completed\]\n\s+branches: \[main\]/,
    );
    expect(on).not.toMatch(/^\s+(push|pull_request|workflow_dispatch|schedule):/m);
  });

  it("acts only on a green push run from this repository", () => {
    // The branch filter matches the NAME `main`, which a fork's PR can carry.
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
  });

  it("runs promote in its holding mode, and deploys nothing itself", () => {
    expect(workflow).toContain("node scripts/ci/promote.mjs --when-certified --yes --no-wait");
    for (const script of ["cloudrun-deploy.sh", "database-deploy.sh", "gate.mjs"]) {
      expect(workflow).not.toContain(script);
    }
    // No install, so no third-party code ever runs beside the token.
    expect(workflow).not.toMatch(/pnpm (install|i)\b|npm (ci|install)/);
  });

  it("checks the commit is on main before running anything from it", () => {
    expect(workflow.indexOf("merge-base --is-ancestor")).toBeGreaterThan(-1);
    expect(workflow.indexOf("merge-base --is-ancestor")).toBeLessThan(
      workflow.indexOf("git checkout --quiet --detach"),
    );
  });

  it("keeps PROMOTE_TOKEN in the promote environment and one step", () => {
    expect(workflow).toMatch(/environment:\n\s+name: promote/);
    expect(workflow.match(/secrets\.PROMOTE_TOKEN/g)).toHaveLength(1);
    const others = ["gate.yml", "heavy.yml", "deploy-production.yml"];
    for (const file of others) {
      expect(read(".github", "workflows", file), `${file} reads PROMOTE_TOKEN`).not.toContain(
        "PROMOTE_TOKEN",
      );
    }
  });

  it("the setup script limits the promote environment to main", () => {
    const setup = read("scripts", "setup-branch-protection.sh");
    expect(setup).toContain("environments/promote");
    expect(setup).toMatch(/-f name=main/);
  });
});
