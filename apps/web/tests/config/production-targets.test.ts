import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEPLOY_JOBS,
  STANDBYS,
  deployVerdict,
  failoverLine,
} from "../../../../scripts/ci/deploy-verdict.mjs";
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

/**
 * The production targets deploy independently, and none holds another's
 * credentials ([D-177]'s addendum, 2026-09-12). Cloud Run took the domain from
 * Fly on 2026-09-23 and Fly was destroyed ([D-184]'s addendum), so the targets
 * are Cloud Run, which serves, and the Vercel failover.
 *
 * Until 2026-09-12 the Neon checkpoint and the migrations lived inside the
 * serving target's job, and the Vercel job `needs:`-ed it. That made two things
 * true that should not be. A failure of the serving platform — the one case a
 * failover exists for — meant the failover could not deploy at all. And a
 * missing Vercel credential turned a release that had shipped into a red run,
 * and `pnpm promote` into a report that production might not have moved.
 *
 * So the database work is a job of its own that both targets need, each job
 * holds only its own secrets, a dispatch can pick one target, and promote
 * judges production by the database job and the job serving the domain. Every
 * one of those is a word in a YAML file or a line in a script, and none of them
 * fails a build when it goes — so this file is where they are held.
 */

const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

const WORKFLOW = read(".github", "workflows", "deploy-production.yml");

/**
 * Each job's own text, keyed by id: from `  <id>:` to the next job. A comment
 * at the job-key indentation sits BETWEEN jobs and describes the one below it,
 * so it ends the job above rather than being charged to it.
 */
function jobBlocks(): Record<string, string> {
  const blocks: Record<string, string> = {};
  let current: string | null = null;
  for (const line of (WORKFLOW.split(/^jobs:$/m)[1] ?? "").split("\n")) {
    const header = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (header) {
      current = header[1];
      blocks[current] = "";
    } else if (/^ {2}#/.test(line)) {
      current = null;
    } else if (current) {
      blocks[current] += `${line}\n`;
    }
  }
  return blocks;
}

const JOBS = jobBlocks();
const job = (id: string) => {
  expect(JOBS[id], `deploy-production.yml has no \`${id}\` job`).toBeDefined();
  return JOBS[id];
};

const secretsOf = (id: string) =>
  new Set([...job(id).matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]));

const needsOf = (id: string) =>
  (/^ {4}needs:\s*\[([^\]]*)\]\s*$/m.exec(job(id))?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const nameOf = (id: string) => /^ {4}name:\s*(.+?)\s*$/m.exec(job(id))?.[1];

/** The names a job's preflight refuses on: `[ -n "${NAME:-}" ] || missing=…`. */
const preflightOf = (id: string) =>
  new Set([...job(id).matchAll(/\[ -n "\$\{([A-Z0-9_]+):-\}" \] \|\| missing=/g)].map((m) => m[1]));

/**
 * The build values, DERIVED from the file the build reads rather than listed
 * here: every `__LOCAL__` key in config/env/production.build.env. Both targets
 * bake the same client bundle for the same commit, so these are the only
 * values the two target jobs share.
 */
const BUILD = new Set(
  read("config", "env", "production.build.env")
    .split("\n")
    .map((line) => /^([A-Z0-9_]+)=__LOCAL__\s*$/.exec(line)?.[1])
    .filter((key): key is string => Boolean(key)),
);

const FLAG = "--database-already-deployed";

const DATABASE = new Set(["DATABASE_URL", "DIRECT_URL", "NEON_API_KEY", "NEON_PROJECT_ID"]);
const VERCEL = new Set(["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"]);
// LIVEKIT_ORIGIN_IP belongs to the probe, and the probe belongs to whichever
// job serves the domain. It moved here from Fly's job with the domain.
const CLOUDRUN = new Set(["GCP_PROJECT_ID", "GCP_DEPLOY_KEY", "LIVEKIT_ORIGIN_IP"]);

/** Every job that deploys somewhere — i.e. every job but the database one. */
const TARGETS = ["cloudrun", "vercel"] as const;

const sorted = (set: Iterable<string>) => [...set].sort();

describe("the database is a job of its own, and no target waits on another", () => {
  it("has exactly the three jobs, and the build values are real", () => {
    expect(Object.keys(JOBS).sort()).toEqual(["cloudrun", "database", "vercel"]);
    // An empty BUILD would make every subset assertion below vacuous.
    expect(BUILD.size).toBeGreaterThan(0);
  });

  it("every target needs the database job, and only the database job", () => {
    expect(needsOf("database")).toEqual([]);
    for (const target of TARGETS) {
      expect(needsOf(target), `the ${target} job must need exactly [database]`).toEqual([
        "database",
      ]);
    }
  });

  it("the database job runs the database script, and no target job runs it", () => {
    expect(job("database")).toMatch(
      /^\s+run: bash scripts\/database-deploy\.sh production --gate-already-passed$/m,
    );
    for (const target of TARGETS) {
      const runs = job(target)
        .split("\n")
        .filter((line) => /^\s+(?:-\s+)?run:/.test(line))
        .join("\n");
      expect(runs, `the ${target} job runs the database script itself`).not.toContain(
        "database-deploy.sh",
      );
    }
  });
});

describe("each job holds its own credentials and no other job's", () => {
  it("the database job holds the database and Neon values, and nothing a target holds", () => {
    expect(sorted(secretsOf("database"))).toEqual(sorted(DATABASE));
  });

  it("the Vercel job holds Vercel's values and the build values — no database, no GCP", () => {
    expect(sorted(secretsOf("vercel"))).toEqual(sorted([...VERCEL, ...BUILD]));
  });

  it("the Cloud Run job holds its own values and the build values — no database, no Vercel", () => {
    expect(sorted(secretsOf("cloudrun"))).toEqual(sorted([...CLOUDRUN, ...BUILD]));
  });

  it("each preflight refuses on exactly its own job's credentials", () => {
    // A preflight that checked another job's secret would make that job's
    // absence fatal here — the exact coupling this split removes.
    expect(sorted(preflightOf("database"))).toEqual(sorted(DATABASE));
    expect(sorted(preflightOf("vercel"))).toEqual(sorted(VERCEL));
    expect(sorted(preflightOf("cloudrun"))).toEqual(sorted(CLOUDRUN));
  });

  it("the Cloud Run job authenticates with a key, not by minting an OIDC token", () => {
    // Workload Identity Federation was built here and removed. It needs
    // `id-token: write`, GitHub grants that per JOB rather than per step, and
    // this job builds the Docker image — so every lifecycle script in the
    // dependency tree would run with a token-minting endpoint in front of it.
    // [D-163]'s addendum reversed that shape once; local-gate.test.ts bans it
    // across every workflow, and this is the reminder at the one place most
    // likely to want an exception. infra/gcp/README.md carries the reasoning.
    expect(job("cloudrun"), "the Cloud Run job grants id-token: write").not.toMatch(
      /^\s+id-token:\s*write\s*$/m,
    );
    expect(secretsOf("cloudrun")).toContain("GCP_DEPLOY_KEY");
  });

  it("no key is written where a process list or a later step could read it", () => {
    // The key reaches gcloud through a file created under umask 077 and removed
    // on exit. `--key-file` takes a path, so the value never becomes an
    // argument (D-66), and no step writes it into the workspace.
    const script = read("scripts", "cloudrun-deploy.sh");
    expect(script).toContain("--key-file=");
    expect(script).toContain("umask 077");
    expect(script).toMatch(/trap '[^']*rm -rf/);
    expect(script, "the key is passed to gcloud as an argument").not.toMatch(
      /--key-file[= ]"?\$GCP_DEPLOY_KEY/,
    );
  });
});

describe("a dispatch can pick one target; a push deploys every one", () => {
  /**
   * Evaluates a job's `if:` for a given run. GitHub's expression syntax is a
   * JavaScript subset for the operators used here, so the translation is
   * mechanical — and an expression using anything else fails loudly in
   * `new Function`, rather than being approximated.
   */
  const selects = (id: string, run: { ref: string; event: string; target?: string }) => {
    const raw = /^ {4}if:\s*\$\{\{\s*(.+?)\s*\}\}\s*$/m.exec(job(id))?.[1];
    expect(raw, `the ${id} job has no \`if:\``).toBeTruthy();
    const js = raw!
      .replaceAll("github.ref", "ctx.ref")
      .replaceAll("github.event_name", "ctx.event")
      .replaceAll("inputs.target", "ctx.target")
      .replaceAll("!=", "!==")
      .replaceAll("==", "===")
      .replaceAll("!===", "!==");
    return Boolean(new Function("ctx", `return (${js});`)({ target: "", ...run }));
  };

  const PRODUCTION = "refs/heads/production";

  const ALL = { database: true, vercel: true, cloudrun: true };

  it.each([
    ["a push", { ref: PRODUCTION, event: "push" }, ALL],
    ["a dispatch for all", { ref: PRODUCTION, event: "workflow_dispatch", target: "all" }, ALL],
    [
      "a dispatch for Vercel",
      { ref: PRODUCTION, event: "workflow_dispatch", target: "vercel" },
      { database: true, vercel: true, cloudrun: false },
    ],
    [
      "a dispatch for Cloud Run",
      { ref: PRODUCTION, event: "workflow_dispatch", target: "cloudrun" },
      { database: true, vercel: false, cloudrun: true },
    ],
    [
      // A dispatch left over from before the cutover, or typed from habit,
      // deploys no target rather than being read as "all".
      "a dispatch still naming Fly",
      { ref: PRODUCTION, event: "workflow_dispatch", target: "fly" },
      { database: true, vercel: false, cloudrun: false },
    ],
    [
      "a dispatch from another branch",
      { ref: "refs/heads/main", event: "workflow_dispatch", target: "all" },
      { database: false, vercel: false, cloudrun: false },
    ],
  ])("%s runs exactly the jobs it should", (_label, run, expected) => {
    expect({
      database: selects("database", run),
      vercel: selects("vercel", run),
      cloudrun: selects("cloudrun", run),
    }).toEqual(expected);
  });

  it("offers exactly those three choices, defaulting to all", () => {
    // `all`, not `both` — a word that stays true whatever the number of
    // targets is, which is why it survived Fly's retirement unchanged.
    const dispatch = WORKFLOW.split(/^ {2}workflow_dispatch:$/m)[1]?.split(/^\S/m)[0] ?? "";
    expect(dispatch).toMatch(/^\s+options: \[all, vercel, cloudrun\]$/m);
    expect(dispatch).toMatch(/^\s+default: all$/m);
  });
});

describe("--database-already-deployed is claimed by no workflow job", () => {
  it("no job passes it — the Cloud Run script holds no database credential at all", () => {
    // The flag existed for Fly's script, which migrated by itself unless told
    // the database job already had. scripts/cloudrun-deploy.sh never migrates,
    // so there is nothing for a job to skip and no claim for a job to make.
    for (const id of Object.keys(JOBS)) {
      expect(job(id), `the ${id} job claims the database is already deployed`).not.toContain(FLAG);
    }
  });

  it("nothing else that runs a deploy passes it", () => {
    // Commented lines may explain the flag; only executable ones may use it.
    const files = execFileSync(
      "git",
      ["ls-files", "--", ".github/workflows", "scripts", "justfile", "package.json"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);

    const users = files.filter((file) =>
      read(file)
        .split("\n")
        .some((line) => {
          const code = line.trim();
          return (
            !code.startsWith("#") &&
            !code.startsWith("//") &&
            !code.startsWith("*") &&
            code.includes(FLAG)
          );
        }),
    );

    // The flag's one definition went with the Fly script. Nothing may bring the
    // idea back without bringing a test with it.
    expect(users).toEqual([]);
  });
});

describe("promote judges production by the database and Cloud Run jobs", () => {
  it("names jobs that exist, under the ids they belong to", () => {
    // `gh run view --json jobs` reports a job by its `name:`. A rename in the
    // workflow that promote did not follow would report every job missing and
    // turn every future promote red.
    expect(nameOf("database")).toBe(DEPLOY_JOBS.database);
    expect(nameOf("cloudrun")).toBe(DEPLOY_JOBS.cloudrun);
    expect(nameOf("vercel")).toBe(DEPLOY_JOBS.vercel);
    expect(Object.keys(DEPLOY_JOBS).sort()).toEqual(Object.keys(JOBS).sort());
  });

  it("every standby is a job, and the job serving the domain is not a standby", () => {
    // STANDBYS is what failoverLine iterates, so a target added to the workflow
    // and not to it would deploy on every release and be reported by nothing.
    for (const key of Object.keys(STANDBYS)) {
      expect(JOBS[key], `STANDBYS names \`${key}\`, which is not a job`).toBeDefined();
    }
    expect(Object.keys(STANDBYS)).toEqual(["vercel"]);
  });

  it("the job that decides is the one that probes and holds the domain", () => {
    // The rule is "whichever job deployed the thing holding spiralclass.com".
    // Probe, environment URL and verdict must name the same job, or a green
    // promote could be reporting on a target that serves nobody.
    const cloudrun = job("cloudrun");
    expect(cloudrun).toMatch(/^\s+run: bash scripts\/local\/synthetic\.sh$/m);
    expect(cloudrun).toMatch(/^\s+url: https:\/\/spiralclass\.com$/m);
    expect(job("vercel"), "the failover probes production").not.toContain("synthetic.sh");
  });

  it("promote reads the verdict job by job, not from the run's exit status", () => {
    const promote = read("scripts", "ci", "promote.mjs");
    expect(promote).toContain("deployVerdict(");
    expect(
      promote,
      "promote watches with --exit-status, which answers for the whole run",
    ).not.toMatch(/"run",\s*"watch",[^\]]*"--exit-status"/);
  });

  it("promote's recovery path deploys what now serves, and migrates first", () => {
    // A recovery command that named Fly would be the first thing an operator
    // typed in an incident, against an app that no longer exists.
    const promote = read("scripts", "ci", "promote.mjs");
    expect(promote).not.toMatch(/fly[-.]/);
    expect(promote).toContain(
      "bash scripts/database-deploy.sh production --gate-already-passed && bash scripts/cloudrun-deploy.sh production --gate-already-passed",
    );
  });

  const jobs = (database: string, cloudrun: string, vercel: string) => [
    { name: DEPLOY_JOBS.database, conclusion: database },
    { name: DEPLOY_JOBS.cloudrun, conclusion: cloudrun },
    { name: DEPLOY_JOBS.vercel, conclusion: vercel },
  ];

  it.each([
    ["everything green", jobs("success", "success", "success"), true],
    ["the failover red", jobs("success", "success", "failure"), true],
    ["the failover not dispatched", jobs("success", "success", "skipped"), true],
    ["Cloud Run red, the failover green", jobs("success", "failure", "success"), false],
    ["Cloud Run not dispatched", jobs("success", "skipped", "success"), false],
    ["the database red, every target skipped", jobs("failure", "skipped", "skipped"), false],
    ["no jobs readable", [], false],
  ])("%s → production %s", (_label, runJobs, productionOk) => {
    expect(deployVerdict(runJobs).productionOk).toBe(productionOk);
  });

  it("a run still carrying the old Fly job is judged by Cloud Run alone", () => {
    // A green job under the retired name must not stand in for the job that
    // serves the domain.
    const verdict = deployVerdict([
      { name: DEPLOY_JOBS.database, conclusion: "success" },
      { name: "Build amd64, deploy to Fly and probe production", conclusion: "success" },
    ]);
    expect(verdict.productionOk).toBe(false);
    expect(verdict.cloudrun).toBe("missing");
  });

  it("reports an in-progress job by its status, and never as green", () => {
    const verdict = deployVerdict([
      { name: DEPLOY_JOBS.database, conclusion: "success" },
      { name: DEPLOY_JOBS.cloudrun, conclusion: "", status: "in_progress" },
    ]);
    expect(verdict).toEqual({
      productionOk: false,
      database: "success",
      cloudrun: "in_progress",
      vercel: "missing",
    });
  });

  it("says a red standby does not decide whether production shipped", () => {
    const line = (vercel: string) => failoverLine({ vercel });
    expect(line("success")).toContain("refreshed");
    expect(line("skipped")).toContain("never on Cloud Run");
    expect(line("failure")).toContain("does not change whether production shipped");
  });

  it("reports every standby on its own line", () => {
    const lines = failoverLine({ vercel: "failure" }).split("\n");
    expect(lines).toHaveLength(Object.keys(STANDBYS).length);
    expect(lines[0]).toContain("⚠ Vercel failover: failure");
  });
});

/**
 * The scripts' own refusals, EXECUTED rather than grepped. Each case exits
 * before any tool that could reach a real service is invoked, and every run
 * gets an environment built from nothing — no inherited token, no inherited
 * database URL, and a HOME with no stored CLI login — so even a regression in
 * the order of the checks has nothing to authenticate with.
 */
describe("the scripts refuse before they touch anything", () => {
  const scratch = mkdtempSync(join(tmpdir(), "production-targets-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /**
   * An environment built from nothing. The app's ProcessEnv type requires
   * NODE_ENV, and leaving everything out — that included — is the point, so the
   * type is asserted rather than satisfied.
   */
  const bareEnv = (vars: Record<string, string>) =>
    ({ HOME: scratch, ...vars }) as unknown as NodeJS.ProcessEnv;

  const bash = (script: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [script, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: bareEnv({ PATH: process.env.PATH ?? "", ...env }),
    });

  const DB = "scripts/database-deploy.sh";

  it("the database script parses", () => {
    const parsed = spawnSync("bash", ["-n", join(REPO_ROOT, DB)], { encoding: "utf8" });
    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it("the database script names no default environment", () => {
    const result = bash(DB, []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage:");
  });

  it("refuses production without the promote gate's handoff", () => {
    const result = bash(DB, ["production"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("without the full promote gate");
  });

  it.each([
    ["neither URL", {}],
    ["only DATABASE_URL", { DATABASE_URL: "postgresql://stub.invalid/x" }],
    ["only DIRECT_URL", { DIRECT_URL: "postgresql://stub.invalid/x" }],
  ])("refuses to migrate with %s", (_label, env) => {
    const result = bash(DB, ["production", "--gate-already-passed"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL and DIRECT_URL must both be in the environment");
    expect(result.stdout).not.toContain("Checkpointing");
  });

  it("refuses production with no NEON_PROJECT_ID, before any checkpoint", () => {
    const result = bash(DB, ["production", "--gate-already-passed"], {
      DATABASE_URL: "postgresql://stub.invalid/x",
      DIRECT_URL: "postgresql://stub.invalid/x",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("NEON_PROJECT_ID is unset");
    expect(result.stdout).not.toContain("Checkpointing");
  });
});
