import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { STEPS, stepsForTier } from "../../../../scripts/ci/steps.mjs";
import { JOBS } from "../../../../scripts/local/jobs.mjs";

// CI runs on the operator's laptop (D-119) AND, as of D-157, on GitHub-hosted
// runners again — the fast tier, the preview deploy and the production deploy.
// D-129 had deleted every workflow and composite action in this repo; the
// premise it argued from was a private repository's metered minutes, and this
// repository is public.
//
// What did NOT change is the thing D-119 actually bought: one definition of
// what the checks are (scripts/ci/steps.mjs) and one definition of what the
// deploy is (scripts/fly-deploy.sh), both of which a laptop and a runner can
// execute. The workflows invoke those; they do not restate them.
//
// That arrangement has a small number of load-bearing invariants and a lot of
// ways to break one by accident, which is what this file locks:
//
//   1. Branch protection requires the `local-gate` context. THREE places have
//      to agree on that string — the poster (scripts/ci/status.mjs), the rule
//      itself (scripts/setup-branch-protection.sh), and the pre-push hook that
//      triggers the poster. A rename in one place strands every PR on a status
//      that never arrives, and the symptom (a merge button stuck on "Expected —
//      waiting for status") looks like a GitHub problem rather than a typo.
//      Note this survives having no workflows: a commit status is a REST API
//      call, not a workflow run, and costs no Actions minutes.
//   2. The workflows CALL the registry and the deploy script; they never
//      restate either. This is the one that replaced "no workflow comes back",
//      and it is the condition on which Actions was allowed back at all. Every
//      reversal in this area has arrived as one well-meaning file, and the
//      well-meaning file to watch for now is a workflow that grows its own
//      `run: pnpm typecheck`.
//   3. Every check that used to run in CI still runs somewhere. The registry is
//      the source of truth and there is still no second copy to drift against,
//      so the assertions here are on the commands themselves.
//   4. The deploy is triggered, never dispatched by hand. What left
//      `production` 96 commits behind live in 2026-07-19 was a HUMAN DISPATCH
//      STEP. `pnpm promote` still runs the full gate and still ends by pushing
//      `production`, and that push is what starts the deploy — so there is
//      still nothing to remember. The approval on the `production` environment
//      is a queued run with a notification, which is the opposite of a step
//      that can be silently skipped.
//   5. The maintenance jobs still EXIST as things a person can run, and their
//      staleness is surfaced. This is the one that reverses D-120 head-on: it
//      kept them on Actions because "a job that silently didn't run is
//      indistinguishable from one that did". Deleting them was the operator's
//      call (D-129); making the silence visible is the part that has to hold.
//      D-157 brought back workflows but deliberately NO `schedule:` trigger,
//      so this stays true — the one exception is the production probes, which
//      run as the last step of the production deploy.
//
// Vitest runs from the package root (apps/web).
const repoRoot = resolve(process.cwd(), "..", "..");
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

/** Tracked paths under `pathspec`. Empty means git knows nothing there. */
const gitLsFiles = (...pathspec: string[]) =>
  execFileSync("git", ["ls-files", "--", ...pathspec], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

/** Strips full-line `#` comments so prose about the old topology can't trip a guard. */
const withoutComments = (text: string) =>
  text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

const CONTEXT = "local-gate";

describe("the required status context (D-119)", () => {
  it("status.mjs posts `local-gate`", () => {
    expect(read("scripts", "ci", "status.mjs")).toMatch(/export const CONTEXT = "local-gate";/);
  });

  it("branch protection requires exactly that context on main", () => {
    const script = withoutComments(read("scripts", "setup-branch-protection.sh"));
    expect(script).toContain(`{ "context": "${CONTEXT}" }`);
    // The old aggregate job context came from a workflow that no longer exists,
    // so requiring it would block every PR on a run nothing can start.
    expect(script).not.toContain("checks / Typecheck / lint / unit / audit");
  });

  it("the pre-push hook runs the gate and hands off the status post", () => {
    const hook = read(".githooks", "pre-push");
    expect(hook).toContain("scripts/ci/gate.mjs");
    expect(hook).toContain("scripts/ci/status.mjs");
    // The escape hatch has to keep existing, and keep being named in the hook:
    // a hook you can't get past gets disabled wholesale instead.
    expect(hook).toContain("SKIP_GATE");
  });

  it("posts through the REST API rather than a workflow", () => {
    // The distinction that lets the status survive D-129: `gh api` costs
    // nothing and needs no runner. A status posted by a workflow would need a
    // workflow.
    const status = read("scripts", "ci", "status.mjs");
    expect(status).toContain("statuses/");
    expect(status).not.toContain("workflow run");
  });
});

// Every workflow file, read once. `.github/actions/` is deliberately absent —
// see "no composite action came back" below.
const WORKFLOW_DIR = join(repoRoot, ".github", "workflows");
const WORKFLOW_FILES = existsSync(WORKFLOW_DIR)
  ? readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  : [];
const workflows = WORKFLOW_FILES.map((file) => ({
  file,
  text: readFileSync(join(WORKFLOW_DIR, file), "utf8"),
}));

/**
 * Everything below the top-level `jobs:` key.
 *
 * Needed because `on:` has two-space children too (`push:`,
 * `workflow_dispatch:`), so counting job-shaped lines across the whole file
 * counts triggers as jobs.
 */
const jobsSection = (text: string) => text.split(/^jobs:$/m)[1] ?? "";

describe("GitHub Actions is back, on stated terms (D-157)", () => {
  // This block is the INVERSE of the one D-129 wrote, not its deletion. D-129
  // asserted `.github/workflows` did not exist, because the constraint then was
  // a private repo's metered minutes and every previous attempt to hold that
  // line by narrowing triggers had ended with a trigger being widened again.
  //
  // The premise changed — the repository is public and the minutes are free —
  // so the guard changes with it rather than being removed. A guard removed is
  // a guard that stops guarding; a guard inverted still holds an invariant, and
  // the invariants worth holding are now about what the workflows may DO.

  it("the workflows exist", () => {
    expect(WORKFLOW_FILES.sort()).toEqual([
      "deploy-preview.yml",
      "deploy-production.yml",
      "gate.yml",
      // D-161. The heavy half of the gate — the suites D-157 recorded as
      // deliberately laptop-only, on a blocker (darwin-only visual baselines)
      // that D-161 removed rather than worked around.
      "heavy.yml",
    ]);
  });

  it("no composite action came back", () => {
    // D-129 deleted four, and every one of them had a local equivalent
    // already. The shared unit between the laptop and a runner is a SCRIPT
    // (scripts/ci/gate.mjs, scripts/fly-deploy.sh), which both can run. A
    // composite action can only run on a runner, so it is a copy of logic that
    // the operator's machine can never execute — exactly the second definition
    // this whole arrangement exists to avoid.
    expect(existsSync(join(repoRoot, ".github", "actions"))).toBe(false);
  });

  it("nothing asks for a runner that is billed on a public repo", () => {
    // The free tier is `ubuntu-latest` and its same-size siblings. Larger
    // runners (`ubuntu-latest-4-cores`, `-8-cores`, `*-xlarge`, anything with a
    // `labels:` block) are billed by the minute EVEN on a public repository,
    // which would quietly reintroduce the meter D-120 and D-129 were arguing
    // with — and the first sign would be a bill, not a red build.
    for (const { file, text } of workflows) {
      const declared = [...text.matchAll(/^\s*runs-on:(.*)$/gm)].map((m) => m[1]);
      expect(declared.length, `${file} declares no runs-on`).toBeGreaterThan(0);
      for (const rest of declared) {
        // Matched on the whole remainder of the line, so a `runs-on:` followed
        // by a `group:` / `labels:` block — the other way to reach a paid
        // runner — fails here rather than slipping through as an empty value.
        const label = rest.replace(/#.*$/, "").trim();
        expect(label, `${file} asks for a runner that is not ubuntu-latest: "${label}"`).toBe(
          "ubuntu-latest",
        );
      }
    }
  });

  it("every third-party action is pinned to a full commit SHA", () => {
    // `sha_pinning_required` is on for this repository, so `@v4` is rejected by
    // policy rather than merely frowned at — but policy is a server setting
    // someone can turn off, and this is the copy of that rule that lives in the
    // repo. A tag can be force-moved; 40 hex characters cannot.
    for (const { file, text } of workflows) {
      const uses = [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]);
      for (const ref of uses) {
        expect(ref, `${file} uses an unpinned action: ${ref}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it("every third-party action names the version its SHA is", () => {
    // A bare 40-character SHA is unreviewable and unmaintainable: nobody can
    // tell v4.2.2 from a rewritten fork by eye, and Dependabot rewrites the
    // SHA and this comment together.
    for (const { file, text } of workflows) {
      for (const line of text.split("\n")) {
        if (!/^\s*(?:-\s+)?uses:/.test(line)) continue;
        expect(line.trim(), `${file}: pin has no version comment: ${line.trim()}`).toMatch(
          /#\s*v?\d+(\.\d+)*/,
        );
      }
    }
  });

  it("every workflow declares its permissions, starting from read", () => {
    // The default token is far broader than any job here needs. Declared at the
    // top of the file so the floor is visible without reading every job, and
    // elevated per job only where something is actually written.
    for (const { file, text } of workflows) {
      expect(text, `${file} has no top-level permissions block`).toMatch(
        /^permissions:\n\s+contents: read$/m,
      );
    }
  });

  it("no workflow runs on a schedule", () => {
    // D-157's scope is the gate and the two deploys, and stops there. A cron
    // fires whether or not anyone is looking, which is the property that made
    // D-129's eleven-day silent backup gap possible — and `scripts/local/`
    // plus the `pnpm gate` nag is the arrangement that replaced it. Bringing
    // one back is a decision, not a drive-by addition to a workflow that
    // already exists.
    for (const { file, text } of workflows) {
      expect(text, `${file} has a schedule trigger`).not.toMatch(/^\s+schedule:/m);
    }
  });

  it("no workflow uses pull_request_target", () => {
    // It runs with a privileged token against untrusted code, and it is how
    // public repositories get compromised. On a repo that is public precisely
    // so it can be read by strangers, this is the single most important line
    // in this file.
    for (const { file, text } of workflows) {
      expect(text, `${file} uses pull_request_target`).not.toContain("pull_request_target");
    }
  });

  it("every workflow has a concurrency group, and no deploy cancels itself", () => {
    // Cancelling a superseded PR run wastes nothing. Cancelling a half-finished
    // deploy leaves migrations applied with no image deployed against them —
    // production serving old code against a new schema.
    for (const { file, text } of workflows) {
      expect(text, `${file} has no concurrency group`).toMatch(/^concurrency:/m);
      if (file.startsWith("deploy-")) {
        expect(text, `${file} may cancel a deploy in flight`).toMatch(
          /cancel-in-progress:\s*false/,
        );
      }
    }
  });

  it("every job has a timeout", () => {
    // The default is six hours. A hung job on a free tier is somebody else's
    // problem; a hung job in a repository read as portfolio evidence is yours.
    for (const { file, text } of workflows) {
      const section = jobsSection(text);
      const jobs = [...section.matchAll(/^ {2}[a-z][a-z0-9-]*:$/gm)].length;
      const timeouts = [...section.matchAll(/^\s*timeout-minutes:/gm)].length;
      expect(jobs, `${file} declares no jobs`).toBeGreaterThan(0);
      expect(timeouts, `${file} has ${jobs} job(s) and ${timeouts} timeout(s)`).toBe(jobs);
    }
  });

  it("no checkout keeps credentials it does not need", () => {
    // Nothing in these workflows pushes. Leaving the token in .git/config hands
    // every test, lint plugin and transitive dependency a credential.
    for (const { file, text } of workflows) {
      // Line-anchored on both counts, so prose in a `#` comment explaining why
      // the setting is there cannot stand in for the setting itself.
      const checkouts = [...text.matchAll(/^\s*(?:-\s+)?uses:\s*actions\/checkout@/gm)].length;
      const disabled = [...text.matchAll(/^\s*persist-credentials:\s*false\s*$/gm)].length;
      expect(disabled, `${file}: ${checkouts} checkout(s), ${disabled} with credentials off`).toBe(
        checkouts,
      );
    }
  });

  it("no untrusted input is interpolated into a shell body", () => {
    // `${{ }}` is substituted before bash ever sees the script, so a value
    // carrying a quote or a `$(…)` executes. Anything event-derived goes
    // through `env:`, where it is data. github.sha / github.run_id / repository
    // are GitHub-generated and cannot carry a payload.
    const SAFE = /^github\.(sha|run_id|repository|server_url|event_name|ref)$/;
    for (const { file, text } of workflows) {
      let inRun = false;
      for (const line of text.split("\n")) {
        if (/^\s*(?:-\s+)?run:\s*\|?/.test(line)) inRun = true;
        else if (/^\s*(?:-\s+)?(uses|name|with|env|if|id):/.test(line)) inRun = false;
        if (!inRun) continue;
        for (const [, expr] of line.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)) {
          expect(expr, `${file} interpolates ${expr} into a run: block`).toMatch(SAFE);
        }
      }
    }
  });
});

describe("the workflows call the registry, and never restate it (D-157)", () => {
  const byName = (name: string) => workflows.find((w) => w.file === name)!.text;

  /** Every `run:` body in a workflow, concatenated. */
  const runBodies = (text: string) =>
    text
      .split("\n")
      .reduce<{ inRun: boolean; lines: string[] }>(
        (acc, line) => {
          if (/^\s*(?:-\s+)?run:/.test(line)) return { inRun: true, lines: [...acc.lines, line] };
          if (/^\s*(?:-\s+)?(uses|name|with|env|if|id|needs):/.test(line))
            return { inRun: false, lines: acc.lines };
          return acc.inRun ? { inRun: true, lines: [...acc.lines, line] } : acc;
        },
        { inRun: false, lines: [] },
      )
      .lines.join("\n");

  it("the gate workflow runs gate.mjs and names a tier, and nothing else", () => {
    // The single most important assertion in this file. Part of what D-129
    // deleted was a dispatch-only copy of every gate job, precisely because it
    // was a second definition of green; re-adding Actions is only safe while
    // the workflow has no opinion about what the steps are.
    expect(byName("gate.yml")).toContain("scripts/ci/gate.mjs");
    expect(byName("gate.yml")).toMatch(/--tier fast/);
  });

  it("the heavy workflow asks the registry for its matrix rather than listing it", () => {
    // Same rule as gate.yml, one level harder to hold: heavy.yml runs its
    // steps as SEPARATE JOBS, and the obvious way to write that is three legs
    // named in YAML. Such a list agrees with steps.mjs on the day it is
    // written and stops agreeing the first time a heavy step is added — the
    // new step runs in `pnpm gate:full` on the laptop, runs in no job here,
    // and nothing says so. So the matrix is DERIVED (D-161), and this asserts
    // it stays derived.
    const heavy = byName("heavy.yml");
    expect(heavy).toMatch(/--tier heavy --list --json/);
    expect(heavy).toContain("fromJSON(needs.plan.outputs.steps)");

    // No heavy step id appears as a literal in anything heavy.yml EXECUTES —
    // not in a matrix, not in an `--only`, not in an `if:`. The id reaches the
    // runner through `matrix.step.id`, which came out of the registry.
    //
    // Comments are stripped first, and deliberately: the header names `e2e.sh`
    // while explaining why no job may invoke it, and a guard that cannot tell
    // an instruction from its own prohibition is one people delete.
    const executable = heavy
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    for (const step of stepsForTier("heavy")) {
      expect(executable, `heavy.yml names the step "${step.id}" literally`).not.toMatch(
        new RegExp(`\\b${step.id}\\b`),
      );
    }
  });

  it("no workflow runs a check the registry already owns", () => {
    // A `run: pnpm typecheck` here would agree with steps.mjs on the day it was
    // written and diverge silently after — which is the drift D-119 removed,
    // and the reason this is a guard rather than a comment.
    //
    // Derived from the registry, so a step ADDED to steps.mjs is covered from
    // the moment it lands, with no list here to remember to widen.
    const registryCommands = STEPS.map((step) => step.cmd.join(" ")).filter(
      // gate.mjs is how a workflow is SUPPOSED to reach these.
      (cmd) => !cmd.includes("scripts/ci/gate.mjs"),
    );
    for (const { file, text } of workflows) {
      const bodies = runBodies(text);
      for (const cmd of registryCommands) {
        expect(bodies, `${file} restates a registry step: ${cmd}`).not.toContain(cmd);
      }
    }
  });

  it("no deploy workflow reimplements a deploy script", () => {
    // The seven steps are ordered and the order is load-bearing — step 1 is the
    // Neon checkpoint that makes a bad migration recoverable. The last time
    // these steps existed in two places, the copy that got re-typed was the one
    // missing the checkpoint (see scripts/fly-deploy.sh's header).
    //
    // ⚠️ WIDENED BY [D-177] FROM "fly-deploy.sh" TO "a deploy script", because
    // there are two targets now. The rule did not change: a deploy workflow
    // CALLS a script a laptop can also run, and states none of the steps
    // itself. What changed is that asserting the Fly script by name would have
    // started failing for the wrong reason the moment a second target's
    // workflow existed — so the assertion is now "at least one of the known
    // deploy scripts", and the forbidden list covers both targets' verbs.
    // scripts/database-deploy.sh joined when the checkpoint and migrations moved
    // out of the Fly script into a job of their own ([D-177]'s addendum). Same
    // rule, a third script.
    const DEPLOY_SCRIPTS = [
      "scripts/fly-deploy.sh",
      "scripts/vercel-deploy.sh",
      "scripts/database-deploy.sh",
    ];

    // Every step a deploy script owns. `vercel pull`, `vercel build` and
    // `vercel deploy` are here for the same reason `docker buildx build` is:
    // the ONE place the Vercel build's env overlay happens is that script, and
    // a workflow that ran `vercel build` itself would skip it and ship the
    // dashboard's values to real browsers. The checkpoint and the migration
    // runner are here because a database job that re-typed them is the
    // 2026-07 failure exactly: the copy that got re-typed lost the checkpoint.
    const FORBIDDEN = [
      "flyctl deploy",
      "docker buildx build",
      "prisma migrate deploy",
      "neon-checkpoint.sh",
      "migrate-regions.ts",
      "vercel pull",
      "vercel build",
      "vercel deploy",
      "vercel promote",
    ];

    for (const { file, text } of workflows.filter((w) => w.file.startsWith("deploy-"))) {
      expect(
        DEPLOY_SCRIPTS.some((script) => text.includes(script)),
        `${file} calls no deploy script — it must invoke one of ${DEPLOY_SCRIPTS.join(" / ")}`,
      ).toBe(true);
      for (const forbidden of FORBIDDEN) {
        expect(runBodies(text), `${file} reimplements a deploy step: ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }
  });

  it("preview asks relevance.mjs rather than declaring its own paths globs", () => {
    // scripts/ci/relevance.mjs already answers "can this change reach a built
    // artifact", is pure, and is table-tested. A `paths:` list would be a
    // second answer, drifting from that one, covered by no test.
    const preview = byName("deploy-preview.yml");
    expect(preview).toContain("scripts/ci/relevance.mjs");
    expect(preview, "deploy-preview.yml declares its own paths filter").not.toMatch(
      /^\s+paths(-ignore)?:/m,
    );
  });

  it("no workflow can mint a token for a secret store", () => {
    // The deploy's values are PUSHED into its environment, so its job needs
    // exactly the twelve it declares and no way to ask for a thirteenth.
    //
    // `id-token: write` would be that way, and it cannot be contained. It is
    // granted per JOB, not per step, so GitHub puts
    // ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN in front of EVERY step in the job —
    // including `pnpm install`, which executes the lifecycle scripts of the
    // whole dependency tree, and the Docker build. Anything running there could
    // mint its own OIDC token and trade it for whatever the identity behind it
    // may read, however narrow this workflow's own request was. That is why
    // that first shape was reversed, and this keeps it reversed.
    //
    // Scoped to EVERY workflow rather than to the deploy: the gate and heavy
    // tiers run far more third-party code than the deploy does, and have no
    // business holding this either.
    for (const { file, text } of workflows) {
      expect(text, `${file} grants id-token: write`).not.toMatch(/^\s+id-token:\s*write\s*$/m);
    }
  });

  it("production deploys behind an environment, and preview cannot reach it", () => {
    // The environment is both the approval gate and the credential boundary:
    // production's Fly token and database URLs exist only inside it, so no
    // other workflow in this repository can reach them even by typo.
    expect(byName("deploy-production.yml")).toMatch(/environment:\n\s+name: production/);
    const preview = byName("deploy-preview.yml");
    expect(preview).toMatch(/environment:\n\s+name: preview/);
    expect(preview, "the preview deploy can reach production credentials").not.toContain(
      "name: production",
    );
  });

  it("only the production branch can reach the production deploy", () => {
    // workflow_dispatch is kept as a recovery path, so this ref guard is what
    // stops it being pointed at an arbitrary branch and shipping it. The push
    // trigger is live again (D-157's addendum 2 — production stays on Fly), so
    // this guards the recovery path rather than the only path.
    expect(byName("deploy-production.yml")).toContain("github.ref == 'refs/heads/production'");
  });

  it("promote refuses to fast-forward when nothing is listening for the push", () => {
    // Promote's anti-drift property is that the push to `production` IS the
    // trigger — with no trigger, promoting moves the branch and deploys
    // nothing, which is the 2026-07-19 incident reached from the other
    // direction. Production's trigger is live today (D-157's addendum 2);
    // this check is what makes taking it off again a loud failure rather than
    // a quiet one.
    //
    // Asserted on the MECHANISM rather than on today's answer: the check reads
    // the trigger off the workflow file, so restoring the trigger clears the
    // refusal with no second edit to remember. Replacing that with a hardcoded
    // flag is the regression this guards.
    const promote = read("scripts", "ci", "promote.mjs");
    expect(promote).toContain("deploy-production.yml");
    // And it happens BEFORE anything is pushed. A refusal after the
    // fast-forward is not a refusal, it is a report.
    expect(promote.indexOf("deploy-production.yml")).toBeLessThan(
      promote.indexOf("refs/heads/production"),
    );
  });
});

describe("the local tier covers what CI used to run", () => {
  it("every step records what it took over from", () => {
    // Provenance only — those workflow files are deleted and nothing checks
    // that they exist. It is what makes the shape of a check readable later.
    for (const step of STEPS) {
      expect(step.replaces, `${step.id} has no \`replaces\` provenance`).toBeTruthy();
    }
  });

  it("the fast tier runs each check checks.yml used to run (minus mutation)", () => {
    const fast = stepsForTier("fast")
      .map((s) => s.cmd.join(" "))
      .join("\n");
    for (const command of [
      "pnpm format:check",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm --filter spiralclass-web test:coverage",
    ]) {
      expect(fast, `fast tier is missing: ${command}`).toContain(command);
    }
    // The audit runs through a wrapper since 2026-09-03, so its flags live in
    // the script rather than in `cmd` — it separates a finding from an
    // unreachable advisory database, after an npm outage reddened every gate
    // in both tiers for over an hour. The flags themselves are asserted in
    // tests/config/audit-step.test.ts, along with the rule that a real finding
    // can never take the "npm was unreachable" exit.
    expect(fast, "fast tier is missing the audit").toContain("node scripts/ci/audit.mjs");
    expect(fast).not.toContain("mutation:spotcheck");
    // Gone entirely with the app — see the decommission describe block below.
    expect(fast).not.toContain("spiralclass-mobile");
  });

  it("the formatting check is whole-tree, not scoped to the diff", () => {
    // It was diff-scoped for a good reason (1553 files of drift to grandfather)
    // and stopped being so for a better one: #1119 landed the last 385 and the
    // count reached zero. The scoping is what made a
    // `prettier-plugin-tailwindcss` 0.6.14 -> 0.8.1 bump invisible on `main` —
    // nothing is changed against `origin/main` there — so a bump that
    // invalidated a third of the .tsx tree left a green gate behind it, and the
    // bill went to the next unrelated branch.
    //
    // Re-scoping it would save ~11 seconds and reopen that. This is here
    // because the well-meaning change to watch for is the one that trades the
    // eleven seconds back.
    // Assert on the CODE, not the prose: the header discusses `--cache` at
    // length in order to reject it, so a whole-file match would fire on the
    // explanation rather than on a regression.
    const check = read("scripts", "format-check.mjs")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(check, "format-check no longer checks the whole tree").toContain('"--check", "."');
    expect(check, "format-check has grown a base ref again — it is diff-scoped").not.toMatch(
      /FORMAT_CHECK_BASE|diff --name-only/,
    );
    // Prettier's own cache key is not guaranteed to cover plugin versions, and
    // a plugin changing its output is exactly what this catches.
    expect(check, "format-check must not cache — see its header").not.toContain("--cache");
  });

  it("the full tier adds mutation and every promote-gate suite", () => {
    const full = stepsForTier("full");
    const scripts = full.map((s) => s.cmd.join(" ")).join("\n");
    for (const suite of ["scripts/ci/integration.sh", "scripts/ci/e2e.sh"]) {
      expect(scripts, `full tier has no step running ${suite}`).toContain(suite);
    }
    expect(scripts).toContain("mutation:spotcheck");
  });

  it("each suite script the registry points at exists", () => {
    for (const step of STEPS) {
      const script = step.cmd.find((arg) => arg.startsWith("scripts/ci/"));
      if (!script) continue;
      expect(existsSync(join(repoRoot, script)), `${step.id} → ${script}`).toBe(true);
    }
  });

  it("pnpm exposes the gate and promote entry points", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts.gate).toContain("scripts/ci/gate.mjs");
    expect(scripts["gate:full"]).toContain("--tier full");
    expect(scripts.promote).toContain("scripts/ci/promote.mjs");
  });
});

// The second client is DELETED (2026-09-04), and these assertions lock
// that decommission. The failure mode they guard is a half-removal: a command,
// a flag or a CI step left pointing at something that is not there. Each one
// therefore names what must stay absent — that naming IS the guard.
describe("the Android app is decommissioned", () => {
  const ids = (tier: "fast" | "full") => stepsForTier(tier).map((s) => s.id);

  it("no gate step in either tier runs anything mobile", () => {
    for (const tier of ["fast", "full"] as const) {
      expect(ids(tier)).not.toContain("test-mobile");
    }
    const registry = STEPS.map((s) => s.cmd.join(" ")).join("\n");
    expect(registry).not.toContain("native-guard.sh");
    expect(registry).not.toContain("mobile-smoke.sh");
    expect(registry).not.toContain("spiralclass-mobile");
  });

  it("the workspace no longer contains a mobile app", () => {
    // The whole point of the decision. If this passes while something below
    // fails, the removal stopped half way.
    //
    // Asked of git, not of the filesystem, and the difference is not academic.
    // `existsSync` was the original spelling and it failed on every machine
    // that had ever built the app: the tracked files went, but
    // apps/mobile/.turbo/ and apps/mobile/node_modules/ are gitignored, so git
    // could neither see them nor remove them. The directory survived as a husk
    // of build artefacts, `git status` read clean, CI stayed green, and the
    // laptop's gate went red on a decision that had in fact been carried out.
    //
    // "The workspace no longer contains a mobile app" is a claim about what is
    // tracked. Nobody's leftover turbo log is a mobile app.
    expect(gitLsFiles("apps/mobile")).toEqual([]);
  });

  it("the scripts deliberately kept on disk are gone too", () => {
    // native-guard.sh and mobile-smoke.sh were kept unregistered-but-present,
    // on the argument that they are what an unfreeze runs first. There is no
    // unfreeze, so they are two files answering a question nobody will ask.
    for (const script of ["native-guard.sh", "mobile-smoke.sh", "mobile-release.mjs"]) {
      expect(existsSync(join(repoRoot, "scripts", "ci", script)), script).toBe(false);
    }
  });

  it("no ship path can reach a mobile release, by flag or otherwise", () => {
    // The inverse of "the unfreeze stays one flag". There is nothing to
    // unfreeze to, so a surviving call site is a command that dies on a missing
    // file rather than an escape hatch.
    //
    // Comment lines are stripped first, deliberately: both files EXPLAIN in
    // their headers what used to run and why it stopped, and that history is
    // the point of keeping the comment. What must not survive is a call.
    for (const file of ["ship.mjs", "promote.mjs"]) {
      const code = read("scripts", "ci", file)
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, `${file} still ships mobile`).not.toContain("mobile-release.mjs");
    }
  });

  it("`--mobile` and `--no-mobile` stay accepted as no-ops on promote", () => {
    // Not for the app's sake — for the operator's. A habit or a runbook line
    // that still passes the flag should not die on an unknown argument; it
    // should promote and say nothing about mobile.
    const promote = read("scripts", "ci", "promote.mjs");
    expect(promote).not.toMatch(/const withMobile/);
    expect(promote).not.toMatch(/process\.exit\(1\).*mobileOk/);
  });

  it("no root script points at a workspace that does not exist", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    for (const [name, cmd] of Object.entries(scripts)) {
      expect(cmd, `pnpm ${name}`).not.toContain("spiralclass-mobile");
      expect(cmd, `pnpm ${name}`).not.toContain("apps/mobile");
      expect(cmd, `pnpm ${name}`).not.toContain("maestro");
    }
  });

  it("the /api/mobile surface is gone too, in its own change", () => {
    // This assertion used to say the opposite, and the inversion is the point.
    // 220 route files were kept because a web component fetched two of them,
    // and said the retirement was its own change with the web caller moved
    // first. Both halves happened: the in-call library browser moved to
    // /api/teacher/library/*, then the tree went.
    //
    // Kept as a guard rather than deleted so a later change cannot recreate a
    // client-named API tree by habit — the name is what made 220 unreachable
    // routes look load-bearing for a month.
    //
    // Asked of git for the same reason as the workspace assertion above: a
    // deleted route tree can leave a build-artefact directory behind, and the
    // claim being made is about tracked source.
    expect(gitLsFiles("apps/web/src/app/api/mobile")).toEqual([]);
    expect(gitLsFiles("apps/web/src/lib/mobile")).toEqual([]);
  });
});

// The aggregate coverage floor is a whole-tree average, so a new file can land
// at 0% and leave it green. `diff:coverage` is the gate that holds ADDED lines
// to their own threshold — and it was defined in apps/web/package.json while
// nothing anywhere invoked it, on PR or otherwise, so new code was only ever
// measured by an average it could hide inside. These lock it in place.
describe("the diff-coverage gate on new code", () => {
  it("runs in the fast tier", () => {
    const fast = stepsForTier("fast").map((s) => s.cmd.join(" "));
    expect(fast).toContain("pnpm --filter spiralclass-web diff:coverage");
  });

  it("runs immediately after the web unit tests, whose coverage file it reads", () => {
    const fast = stepsForTier("fast");
    const web = fast.findIndex((s) => s.id === "test-web");
    const diff = fast.findIndex((s) => s.id === "diff-coverage");
    expect(web).toBeGreaterThanOrEqual(0);
    expect(diff).toBe(web + 1);
  });

  it("the web coverage run still emits the json report it consumes", () => {
    // v8's `json` reporter is what writes coverage-final.json; without it the
    // gate has nothing to read and fails for a reason that looks unrelated.
    expect(read("apps", "web", "vitest.config.ts")).toMatch(/reporter:\s*\[[^\]]*"json"/);
  });
});
// The machine lock (D-146). This laptop is the only runner (D-119, D-129) and
// it is shared by several Claude Code sessions at once, each in its own git
// worktree. Three things they contend for are singletons, and two of them
// corrupt rather than merely queue:
//
//   * apps/web/docker-compose.test.yml pins `container_name:
//     spiralclass-test-db` on port 5433 — ONE container for the machine,
//     whichever worktree booted it. integration.sh drops and recreates
//     `spiralclass_drift` WITH (FORCE) mid-run; GATE_FRESH_DB=1 removes the
//     volume outright. Concurrent runs corrupt each other's database.
//   * e2e.sh serves the built app on port 3000 and already treats a stray
//     server there as a correctness problem, not an inconvenience.
//   * Both build with --max-old-space-size=6144, on a 16GB machine that is also
//     hosting the sessions that started them.
//
// So the lock is not a nicety, and these lock the parts that are easy to
// unpick by accident: that it exists, that it is machine-scoped rather than
// per-checkout, and that the suites take it themselves so a hand-run is
// covered too.
describe("one heavy job at a time on this machine (D-146)", () => {
  it("the gate takes the lock, and releases it before the bookkeeping", () => {
    const gate = read("scripts", "ci", "gate.mjs");
    expect(gate).toContain("./lock.mjs");
    expect(gate).toMatch(/await acquire\(/);
    // Released before the receipt/status/nag tail, so the next session in the
    // queue isn't waiting on a network call.
    expect(gate.indexOf("lock.release()")).toBeLessThan(gate.indexOf("postStatus({ receipt })"));
  });

  it("the lock is machine-scoped, not per-worktree", () => {
    // The whole point. `.gate/` resolves relative to scripts/ci/lib.mjs, which
    // has one copy per worktree — a lock in there would be seven locks.
    const lock = read("scripts", "ci", "lock.mjs");
    expect(lock).toMatch(/LOCK_ROOT[\s\S]{0,200}homedir\(\)/);
    // Assert on the import STATEMENTS, not on the text of the file: the header
    // comment explains at length why `.gate/` is the wrong home for a lock,
    // and prose about a mistake must not be readable as the mistake.
    const imports = lock
      .split("\n")
      .filter((line) => line.startsWith("import "))
      .join("\n");
    expect(imports).not.toMatch(/RECEIPT_DIR/);
  });

  it("the suites that own the singletons take it themselves", () => {
    // Not only via gate.mjs: `pnpm test:integration:local` and a bare
    // `bash scripts/ci/e2e.sh` have to be serialized too, or the guarantee is
    // only as good as the entry point someone happened to use.
    for (const suite of ["integration.sh", "e2e.sh"]) {
      const src = read("scripts", "ci", suite);
      expect(src, `${suite} does not take the machine lock`).toContain("lock.mjs run");
      expect(src, `${suite} can recurse into itself`).toContain("SPIRALCLASS_LOCK_INNER");
    }
  });

  it("a child of the gate passes through instead of deadlocking on its parent", () => {
    // gate.mjs holds the lock and then runs integration.sh, which takes it.
    // Without the token in the child's env that is a guaranteed hang.
    expect(read("scripts", "ci", "gate.mjs")).toContain("lockEnv(lock.token)");
    expect(read("scripts", "ci", "lock.mjs")).toContain("SPIRALCLASS_LOCK_TOKEN");
  });

  it("a dead holder does not wedge the machine", () => {
    // A gate killed with Ctrl-C or an OOM leaves a holder directory behind. If
    // that were permanent, the recovery would be deleting a directory nobody
    // knows exists.
    const lock = read("scripts", "ci", "lock.mjs");
    expect(lock).toMatch(/pidAlive/);
    expect(lock).toMatch(/process\.kill\(pid, 0\)/);
  });

  it("turbo's cache is shared across every checkout", () => {
    // Seven worktrees with seven in-repo `.turbo` caches means seven sessions
    // each paying full price for the identical typecheck. Turbo keys on a
    // content hash, not a path, so one cache outside the repo is a hit for all
    // of them. Measured: 1.5s cold, 302ms FULL TURBO from another checkout.
    const wrapper = read("scripts", "turbo.mjs");
    expect(wrapper).toContain("TURBO_CACHE_DIR");
    expect(wrapper).toMatch(/homedir\(\)/);
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    for (const task of ["build", "lint", "typecheck", "test"]) {
      expect(scripts[task], `${task} bypasses the shared turbo cache`).toContain(
        "scripts/turbo.mjs",
      );
    }
  });
});

// The Tier 2 list is no longer a gate input (D-146 removed the escalation from
// both scripts that greped for it), but it did not stop being real: it is what
// decides whether to spend a `GATE_TIER=full` push, whether to serialize a
// worktree, and whether to merge during lesson hours. It now lives only in
// prose, so this checks the prose still has it — a list that exists nowhere is
// a rule nobody can follow.
describe("the Tier 2 list survives as operator guidance", () => {
  it("CLAUDE.md still names the production-risk paths", () => {
    const claude = read("CLAUDE.md");
    for (const fragment of [
      "payments",
      "stripe",
      "subscriptions",
      "booking",
      "cancellation",
      "webhooks",
      "prisma",
      "middleware.ts",
    ]) {
      expect(claude, `CLAUDE.md no longer names ${fragment} as Tier 2`).toContain(fragment);
    }
  });
});

describe("the maintenance the crons used to do still exists (D-129)", () => {
  // D-120 kept nightly-checks.yml, synthetic.yml and backup-prod-db.yml on
  // Actions on the argument that a laptop cannot be trusted with a schedule.
  // D-129 accepted the operator's constraint instead — no Actions on a private
  // repo, and no laptop scheduler either — which made those commands.
  // The argument D-120 made was still correct about ONE thing, and it is the
  // part these tests protect: the danger is not that a job is un-run, it is
  // that an un-run job looks exactly like a green one.
  const JOB_IDS = JOBS.map((job) => job.id);

  it("registers the jobs that are actually a practice — and no others", () => {
    // `backup` was here until 2026-08-25 (D-129 addendum). The operator's call
    // is that Neon already backs production up, so a hand-run pg_dump is not a
    // routine. It is out of the registry rather than merely un-run: a nag for a
    // decision already made trains the operator to ignore the whole banner, and
    // the banner is the only mechanism the other two have.
    expect(JOB_IDS).toEqual(["synthetic", "sweep"]);
  });

  it("the off-Neon dump survives as an on-demand tool, unregistered", () => {
    // Kept, not deleted: it is the only thing that produces a copy living
    // outside Neon entirely, which is the case Neon's own PITR cannot cover.
    // Deleting it would mean rebuilding it on the day that case arrives.
    expect(existsSync(join(repoRoot, "scripts", "local", "backup-prod-db.sh"))).toBe(true);
    expect(read("scripts", "local", "run.mjs")).not.toContain("pnpm local backup");
  });

  it("each one is a real script, not a note in a runbook", () => {
    for (const job of JOBS) {
      const script = job.cmd.find((arg) => arg.startsWith("scripts/local/"));
      expect(script, `${job.id} runs nothing under scripts/local/`).toBeTruthy();
      expect(existsSync(join(repoRoot, script!)), `${job.id} → ${script}`).toBe(true);
    }
  });

  // ...and the steps those scripts ask the gate for must EXIST.
  //
  // The failure this exists for, in full: `test-mobile` was unregistered
  // from STEPS and `scripts/local/sweep.sh` still passed it to
  // `--only`. The gate rejects an unknown id, so the sweep exited 2 in about a
  // second having run nothing — and because a job that never succeeds looks
  // identical to one nobody has run, the weekly nag reported "last green
  // never" and read as a chore rather than a breakage.
  //
  // That is the exact failure mode the block above says these tests exist to
  // prevent ("the danger is not that a job is un-run, it is that an un-run job
  // looks exactly like a green one") — arriving through the one door left
  // open, the step ids. A registry and its callers were two lists nothing
  // joined; this joins them.
  it("only asks the gate for steps that are actually registered", () => {
    const ids = new Set(STEPS.map((s) => s.id));
    const offenders: string[] = [];

    for (const job of JOBS) {
      const script = job.cmd.find((arg) => arg.startsWith("scripts/local/"));
      if (!script) continue;
      const source = readFileSync(join(repoRoot, script), "utf8");
      // `--only a,b,c`, however the line is wrapped or continued.
      for (const match of source.matchAll(/--only[\s\\]+([a-z0-9,-]+)/gi)) {
        for (const id of match[1].split(",").filter(Boolean)) {
          if (!ids.has(id)) offenders.push(`${script} → --only ${id}`);
        }
      }
    }

    expect(
      offenders,
      "A local job asks the gate for a step id that is not in scripts/ci/steps.mjs. " +
        "The gate rejects unknown ids and the job dies before running anything, " +
        "which the maintenance nag cannot tell apart from nobody running it:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("every run leaves a receipt, so 'did it happen' is a fact and not a memory", () => {
    const runner = read("scripts", "local", "run.mjs");
    expect(runner).toContain("recordRun");
    // A red run must not reset the clock, or a task failing for a fortnight
    // reads as fresh.
    expect(read("scripts", "local", "receipts.mjs")).toContain("lastOk");
  });

  it("a failure reaches the operator on both channels", () => {
    // The phone for "started it and walked away", the desktop for "it scrolled
    // off in a tab". Actions had an emailed failure; a terminal has neither.
    const notify = read("scripts", "local", "notify.sh");
    expect(notify).toContain("ntfy");
    expect(notify).toContain("osascript");
    // Alerting must never be the thing that fails the task.
    expect(notify).toContain("exit 0");
  });

  it("the gate warns when one is overdue", () => {
    // The whole replacement for the cron: nothing starts these, so the operator
    // is told at the one moment they are provably at the keyboard. The pre-push
    // hook runs the gate on every push.
    const gate = read("scripts", "ci", "gate.mjs");
    expect(gate).toContain("staleWarnings");
    expect(read("package.json")).toContain("scripts/local/status.mjs");
  });

  it("the nag is a warning, never a gate failure", () => {
    // A stale backup is not a reason to reject a commit, and a check that
    // blocks work for something unrelated to the work gets bypassed wholesale.
    const gate = read("scripts", "ci", "gate.mjs");
    const warn = gate.indexOf("staleWarnings");
    const verdict = gate.indexOf("return ok ? 0 : 1;");
    expect(warn).toBeGreaterThan(-1);
    expect(warn, "the nag must not participate in the verdict").toBeLessThan(verdict);
    expect(gate).not.toMatch(/ok\s*&&\s*.*stale/i);
  });

  it("the LiveKit cert probe checks the ORIGIN, not Cloudflare's edge", () => {
    // The subtle way this probe could go quietly useless: check
    // https://livekit.spiralclass.com and you read CLOUDFLARE's certificate,
    // which is always valid and says nothing about whether Caddy renewed. Since
    // D-134 proxied the record, the probe has to dial the box's own IP with SNI.
    const probes = read("scripts", "local", "synthetic.sh");
    expect(probes).toContain("LIVEKIT_ORIGIN_IP");
    expect(probes).toMatch(/openssl s_client -connect "\$\{LIVEKIT_ORIGIN_IP\}:443"/);
    expect(probes).toMatch(/-servername "\$\{LIVEKIT_HOST\}"/);
    // -checkend, not date arithmetic: BSD date has no -d and this runs on a Mac.
    expect(probes).toContain("-checkend");
    // A threshold shorter than Caddy's own ~30-day renewal trigger, so firing
    // means a renewal already failed rather than that one is merely due.
    const m = /LIVEKIT_CERT_MIN_DAYS:-(\d+)/.exec(probes);
    expect(m, "LIVEKIT_CERT_MIN_DAYS must keep a default").not.toBeNull();
    expect(Number(m![1])).toBeLessThan(30);
    expect(Number(m![1])).toBeGreaterThan(7);
  });

  it("the probes run themselves after a production deploy", () => {
    // The one thing a clock genuinely did better, recovered without one: a
    // deploy is when the regressions synthetic.yml caught get introduced, so
    // they run then rather than waiting up to 12 hours to find out.
    //
    // They moved with the deploy (D-157) — from `pnpm promote` into
    // deploy-production.yml, which is now the thing that knows production is
    // actually serving new code. Called as the bare script rather than through
    // `pnpm local synthetic`: that wrapper exists to give a hand-run task the
    // run history and failure notification Actions used to provide for free,
    // and on Actions a red job already is both.
    const production = workflows.find((w) => w.file === "deploy-production.yml")!.text;
    expect(production).toContain("scripts/local/synthetic.sh");
    // After the deploy, never before it — probing the old release and calling
    // it a verified deploy is worse than not probing at all.
    expect(production.indexOf("scripts/fly-deploy.sh")).toBeLessThan(
      production.indexOf("scripts/local/synthetic.sh"),
    );
  });
});

describe("the deploy is triggered, never dispatched by hand", () => {
  it("promote ends by pushing production, which IS the deploy trigger", () => {
    // The 2026-07-19 drift (production 96 commits behind live) came from a
    // HUMAN DISPATCH STEP, not from where the build ran. D-120's answer was to
    // chain the deploy into promote; D-157 moves the build to a runner and
    // keeps the chain, because the push promote makes is what starts the
    // workflow. Nothing in between is left for anyone to remember.
    const promote = read("scripts", "ci", "promote.mjs");
    expect(promote).toMatch(/push".*refs\/heads\/production|refs\/heads\/production/);
    // And it waits for the result, so a green `pnpm promote` still means
    // production is serving — which is what that command has always meant.
    expect(promote).toContain("run watch");
    expect(promote).toContain("--exit-status");
  });

  it("the local deploy stays available as the recovery path", () => {
    // A workflow that cannot run — an Actions outage, a revoked token, a
    // repository that went private again — must not be the only way to deploy.
    // This is the same script the workflow calls, so recovering is not a
    // different deploy.
    const promote = read("scripts", "ci", "promote.mjs");
    expect(promote).toContain("scripts/fly-deploy.sh");
    expect(promote).toContain("--gate-already-passed");
  });

  it("fly-deploy.sh accepts the handoff promote makes", () => {
    expect(read("scripts", "fly-deploy.sh")).toContain("--gate-already-passed");
  });

  it("still refuses a bare local production deploy with no gate", () => {
    // --gate-already-passed must not become a way to skip the gate by hand.
    expect(read("scripts", "fly-deploy.sh")).toContain(
      "--yes-i-understand-this-skips-the-promote-gate",
    );
  });

  it("the local production deploy still checkpoints Neon before it migrates", () => {
    // D-95 made a named pre-migration restore point production's primary safety
    // net, and it was a step in fly-deploy.yml's `production` job. D-120 moved
    // the deploy into scripts/fly-deploy.sh and left the checkpoint behind — so
    // a promote applied migrations to production with no restore point while
    // promote.mjs printed "Neon checkpoint" in its success summary either way.
    // A code rollback never undoes a migration, so this is the step whose
    // absence only shows up on the day it is needed.
    //
    // Both steps moved into scripts/database-deploy.sh when the production
    // targets were split ([D-177]'s addendum); a hand-run fly-deploy.sh still
    // runs that script before it builds anything, which
    // neon-checkpoint-retention.test.ts pins.
    const deploy = withoutComments(read("scripts", "database-deploy.sh"));
    const checkpoint = deploy.indexOf("neon-checkpoint.sh");
    const migrate = deploy.indexOf("migrate-regions.ts");

    expect(checkpoint, "database-deploy.sh no longer runs neon-checkpoint.sh").toBeGreaterThan(-1);
    expect(migrate, "database-deploy.sh no longer applies migrations").toBeGreaterThan(-1);
    // Order is the whole point: a checkpoint taken after the migration is not a
    // restore point for that migration.
    expect(checkpoint, "the checkpoint must run BEFORE migrations").toBeLessThan(migrate);
    // ...and only for production — preview is disposable.
    expect(deploy).toContain('if [ "$ENVIRONMENT" = "production" ]');
  });

  it("mints the registry credential after the slow build, not before it", () => {
    // The amd64 image is cross-built under QEMU on an arm64 Mac (2-10 min,
    // depending on surviving layer cache); `flyctl auth docker` mints a
    // credential good for ~5-6. A single `buildx build --push` therefore RACES
    // that token: minted before the build, used at the very end of it. When the
    // build wins, the push fails with `unknown: app repository not found` —
    // Fly's registry reports an expired credential as a missing repository, so
    // it reads as a misconfiguration rather than the timeout it is. On
    // 2026-08-30 a 565s build failed exactly this way and left three merged PRs
    // deployed nowhere, while a 102s build through the same script had pushed
    // fine an hour earlier.
    const deploy = withoutComments(read("scripts", "fly-deploy.sh"));
    const build = deploy.indexOf("docker buildx build");
    const auth = deploy.indexOf("flyctl auth docker");
    const push = deploy.indexOf("--push");

    expect(build, "fly-deploy.sh no longer builds the image").toBeGreaterThan(-1);
    expect(auth, "fly-deploy.sh no longer authenticates to the registry").toBeGreaterThan(-1);
    expect(push, "fly-deploy.sh no longer pushes the image").toBeGreaterThan(-1);

    // Order is the whole fix: build first, authenticate once the slow part is
    // done, then push against a fresh token. Collapsing these back into a
    // single `buildx build --push` reintroduces the race.
    expect(build, "the image must be built BEFORE the credential is minted").toBeLessThan(auth);
    expect(auth, "the credential must be minted BEFORE the push").toBeLessThan(push);
  });

  it("preview has a local entry point, since merging to main no longer deploys it", () => {
    // Hand-testing runs against the DEPLOYED preview backend, so preview going
    // stale is a real failure mode with a non-obvious symptom.
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["deploy:preview"]).toContain("fly-deploy.sh preview");
  });

  it("ship:preview skips a deploy this commit cannot have changed", () => {
    // The `&&` chain it replaced deployed for every commit, including the many
    // that change nothing it carries: a 20-30 min QEMU build for a docs-only
    // change. A command that expensive to run gets run less, which is worse
    // than the cost it saves.
    const ship = read("scripts", "ci", "ship.mjs");
    expect(ship).toContain("changedTargets");
    expect(ship).toContain("lastRelease");
    // "No record" must never read as "nothing changed" — that is the only
    // direction of this optimisation that can silently ship nothing.
    expect(ship).toContain("=== null");
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["ship:preview"]).toContain("ship.mjs");
  });

  it("promote ships only a commit the runners certified ([D-162])", () => {
    // What certifies a release stopped being a local receipt when ship-pr was
    // deleted. The receipt was a self-attestation — a file promote wrote and
    // then believed; the replacement is two workflow runs bound to the same
    // SHA, on the machine that also builds the image.
    const promote = read("scripts", "ci", "promote.mjs");
    expect(promote).toContain("CERTIFYING_WORKFLOWS");
    expect(promote).toMatch(/"Gate", "Heavy"/);
    // Nothing local may stand in for that answer any more.
    expect(promote, "promote still reads the deleted full-tier receipt").not.toContain(
      "greenFullReceipt",
    );
    expect(promote).not.toContain("RECEIPT_PATH");
  });

  it("promote asks about the PUSH run, not a pull_request one", () => {
    // A pull_request run's head SHA is the branch tip, and a squash merge does
    // not preserve it — the commit on `main` is a different object that run
    // never saw. Accepting it would certify a tree that was never built.
    expect(read("scripts", "ci", "promote.mjs")).toMatch(/event"?\s*==\s*"push"/);
  });

  it("promote picks the newest run per workflow, by timestamp", () => {
    // The short version of this took the first entry the API returned, on the
    // undocumented fact that it sorts newest-first. That dependency fails in
    // the wrong direction: a stale green ahead of a newer red would CERTIFY,
    // while every other unknown on this path is a refusal. More than one push
    // run per workflow per SHA is ordinary — a re-run after a flake is exactly
    // that.
    const promote = read("scripts", "ci", "promote.mjs");
    expect(promote).toContain("created_at");
    expect(promote).toMatch(/Date\.parse/);
    // An unparseable timestamp must sort oldest rather than winning by default.
    expect(promote).toMatch(/-Infinity/);
  });

  it("promote fails closed when it cannot read the verdict", () => {
    // The one thing that must never happen: shipping because nothing could be
    // found to say the commit was broken. No gh, no network, a moved API shape
    // and a run still in flight all have to stop the promote, and --force-gate
    // is the deliberate way through.
    const promote = read("scripts", "ci", "promote.mjs");
    expect(promote).toMatch(/if \(!verdicts\)/);
    expect(promote).toMatch(/in_progress/);
    expect(promote).toContain("--force-gate");
  });

  it("promote says when it is shipping a commit preview never saw", () => {
    // A warning, not a gate: hotfixes exist and the ledger only knows this
    // machine. But nothing could say it at all before the ledger.
    expect(read("scripts", "ci", "promote.mjs")).toContain('kind: "web-deploy", env: "preview"');
  });

  it("every ship path leaves a record", () => {
    // The failure mode is silence: nothing on disk disagrees when a ship is
    // skipped. The ledger is what disagrees, and release:status is what reads
    // it.
    expect(read("scripts", "fly-deploy.sh")).toContain("record-release.mjs");
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["release:status"]).toContain("release-status.mjs");
    // The orchestration moved out of the package script into ship.mjs when it
    // grew the skip logic, so assert on what that script drives.
    const ship = read("scripts", "ci", "ship.mjs");
    expect(pkg.scripts["ship:preview"]).toContain("ship.mjs");
    expect(ship).toContain("scripts/fly-deploy.sh");
  });
});

// scripts/open-pr.sh is the front half of shipping and stops at an open PR.
//
// The back half used to be scripts/ship-pr.sh, which merged a batch and then
// held the machine for 20-40 minutes running the full tier against merged
// `main` (D-146). [D-162] deleted it: `heavy.yml` runs those suites on every PR
// AND on every push to `main`, so the merged-tree check happens on a runner
// with nothing to remember, and the back half is now `gh pr merge` plus
// `pnpm promote`.
//
// What has NOT changed is why the front half stops where it does. A `/pr` that
// also merged or deployed would look like a convenience right up until it was
// promoting a commit nobody had reviewed, from a worktree, on a whim.
describe("opening a PR is the front half, and only the front half", () => {
  const openPr = () => withoutComments(read("scripts", "open-pr.sh"));

  it("never merges, deploys or promotes", () => {
    const src = openPr();
    for (const back of [
      "gh pr merge",
      "ship.mjs",
      "ship:preview",
      "promote.mjs",
      "pnpm promote",
      "fly-deploy.sh",
    ]) {
      expect(src, `open-pr.sh reaches into the back half via '${back}'`).not.toContain(back);
    }
  });

  it("never bypasses the gate", () => {
    // This push is the only thing that runs the checks locally and the only
    // thing that produces the `local-gate` status from this machine, so a
    // bypass here is a PR that cannot merge at best and red code on `main` at
    // worst.
    const src = openPr();
    for (const bypass of ["SKIP_GATE", "--no-verify", "--force-gate", "GATE_TIER"]) {
      expect(src, `open-pr.sh can bypass the gate via '${bypass}'`).not.toContain(bypass);
    }
  });

  it("never force-pushes, and never moves a branch it doesn't own", () => {
    const src = openPr();
    expect(src).not.toMatch(/git push[^\n]*(--force|-f\b)/);
    // A collision on a derived branch name is the realistic case; the cost of
    // guessing wrong is another session's work overwritten.
    expect(src).toMatch(/refs\/remotes\/origin\/\$BRANCH/);
  });

  it("never checks out main, which lives in another worktree", () => {
    // The primary checkout holds `main` while sessions work in
    // .claude/worktrees/*, so `git checkout main` fails outright there.
    const src = openPr();
    expect(src).not.toMatch(/git checkout[^\n]*\bmain\b/);
    expect(src).toMatch(/HEAD is on 'main'/);
  });

  it("waits for the status branch protection actually reads", () => {
    // Green locally and green on GitHub are two facts: status.mjs posts from a
    // DETACHED process after the push lands. Only the second one unblocks the
    // merge button, so this asks for the second.
    const src = openPr();
    expect(src).toContain(`select(.context == "${CONTEXT}")`);
  });

  it("is reachable as a command and as a skill", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts.pr).toContain("scripts/open-pr.sh");
    expect(existsSync(join(repoRoot, ".claude", "skills", "pr", "SKILL.md"))).toBe(true);
  });

  it("has no back half left on disk to reach for", () => {
    // Inverted rather than deleted, which is this file's standing habit. D-162
    // removed ship-pr because heavy.yml covers what it covered; a half-removal
    // that leaves the script, the pnpm alias or the skill behind is the failure
    // mode, because each of them still LOOKS like the supported path.
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["ship-pr"], "package.json still exposes ship-pr").toBeUndefined();
    expect(existsSync(join(repoRoot, "scripts", "ship-pr.sh"))).toBe(false);
    expect(existsSync(join(repoRoot, ".claude", "skills", "ship-pr"))).toBe(false);
    // Anchored with a delimiter: `ship-preview` is a live recipe and starts
    // with the same eight characters.
    expect(read("justfile"), "the justfile still has a ship-pr recipe").not.toMatch(
      /^ship-pr[ :]/m,
    );
  });
});

// D-146 moved the heavy suites to one run per BATCH, on the merged result,
// because one laptop shared by several sessions could not afford one run per
// branch. `pnpm ship-pr` was where that run lived.
//
// [D-162] deleted ship-pr. The invariant it protected did NOT go with it, and
// this is where it now lives: the heavy suites still run against the tree that
// actually lands, and something still refuses to ship a commit they have not
// passed. What changed is that both of those are now automatic — a runner and
// a query — rather than a command someone had to remember to type.
describe("the heavy suites still see the merged tree (D-146, D-162)", () => {
  const heavy = () => read(".github", "workflows", "heavy.yml");

  it("runs on pushes to main, not only on pull requests", () => {
    // A pull_request run tests HEAD merged with base AS OF THAT MOMENT. If main
    // moves between that run and the merge, the tree that landed is not the
    // tree that was tested — and a combination that breaks though each half was
    // green alone is exactly what these suites are for.
    const triggers = heavy().split(/^on:$/m)[1]?.split(/^\S/m)[0] ?? "";
    expect(triggers, "heavy.yml does not run on pull requests").toMatch(/^\s+pull_request:/m);
    expect(triggers, "heavy.yml does not run on pushes to main").toMatch(/^\s+push:/m);
    expect(triggers).toMatch(/branches:\s*\[main\]/);
  });

  it("publishes one stable name for the whole tier", () => {
    // The matrix legs are named from the registry, so they appear and disappear
    // as steps are added. A required check — or promote's query — cannot depend
    // on a name that moves, so the summary job provides one that does not.
    expect(heavy()).toMatch(/^\s+name: Heavy tier$/m);
  });

  it("the summary job cannot pass while a leg failed", () => {
    // `always()` makes it RUN regardless; it must still FAIL unless both the
    // plan and the matrix aggregate say success. A summary that is green
    // whenever it ran is worse than no summary, because promote reads it.
    const heavyYml = heavy();
    expect(heavyYml).toMatch(/needs\.plan\.result/);
    expect(heavyYml).toMatch(/needs\.heavy\.result/);
    expect(heavyYml).toMatch(/!=\s*"success"/);
  });

  it("nothing local claims to certify a release any more", () => {
    // The half-removal to guard against: ship-pr gone, but some other script
    // still writing or reading a full-tier receipt and calling it a release
    // gate. `pnpm gate:full` still EXISTS and is still useful — it just no
    // longer certifies anything on its own.
    expect(existsSync(join(repoRoot, "scripts", "ship-pr.sh"))).toBe(false);
    // Comments stripped: promote's header explains what replaced ship-pr and
    // has to be able to name it. A guard that cannot tell an explanation from
    // the thing it explains is one people delete.
    const promote = read("scripts", "ci", "promote.mjs")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
      .join("\n");
    expect(promote, "promote still calls ship-pr").not.toContain("ship-pr");
    expect(promote, "promote still reads a full-tier receipt").not.toMatch(/tier === "full"/);
  });
});
