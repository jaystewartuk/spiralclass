import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

/**
 * The Vercel target is a FAILOVER, not a fork — and every property that makes
 * that true is invisible in a diff.
 *
 * [D-177] reversed one sentence of [D-89] Phase 5: the Vercel project exists
 * again, as a second production target for the same commit. What it did NOT
 * reverse is everything that made the teardown worth doing — the app stayed
 * platform-neutral, the deploy stayed Actions-driven, and the database stayed
 * the business of exactly one job.
 * `apps/web/tests/config/decommissioned-platforms.test.ts` holds the first of
 * those. This file holds the other two, plus the three things about the new
 * machinery that would break silently:
 *
 *   1. THE DATABASE WORK HAPPENS ONCE. scripts/vercel-deploy.sh deliberately
 *      runs no Neon checkpoint and no migrations, because the `database` job it
 *      `needs:` already ran scripts/database-deploy.sh for this commit. That job
 *      was the Fly job until [D-177]'s addendum split them, so the failover no
 *      longer waits on Fly. It is only safe while the ordering holds, and
 *      `needs:` is one word — delete it and the failover races the migrations,
 *      free to serve code against a schema that has not moved yet.
 *   2. IT NEVER TAKES THE DOMAIN. `--skip-domain` is the whole difference
 *      between "the failover is warm" and "a CI job performed a DNS cutover".
 *      Drop the flag and `vercel deploy --prod` assigns spiralclass.com on the
 *      next release, which is the operator's call under CLAUDE.md's first rule
 *      and nobody else's.
 *   3. IT HOLDS NO DATABASE CREDENTIAL. The job has no business with the
 *      schema, and the narrowest way to say so is to not hand it the means —
 *      so a DATABASE_URL or NEON_API_KEY appearing in that job is a finding,
 *      not a convenience.
 *
 * None of these fails a build on its own. Each one type-checks, lints, and
 * deploys green; the tell would be in production, after a promote.
 */

const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

const WORKFLOW = read(".github", "workflows", "deploy-production.yml");
const SCRIPT = read("scripts", "vercel-deploy.sh");
const CONFIG_PATH = "config/vercel/production.json";

/**
 * The `vercel:` job's own text — from its header to whatever follows it.
 *
 * This read to the end of the file until [D-184] added a third target after it,
 * at which point every "the Vercel job must not contain X" assertion here was
 * quietly also asserting it about Cloud Run's job — and the Cloud Run job
 * explains its credential by naming FLY_API_TOKEN, so the first symptom was a
 * failure that pointed at the wrong job entirely. A slice that depends on being
 * last is a premise that dies silently the first time it is not.
 *
 * It ends at the next thing at job indentation: another job header, or a
 * comment block between jobs, which describes the job BELOW it.
 */
const vercelJob = () => {
  const at = WORKFLOW.indexOf("\n  vercel:\n");
  expect(at, "deploy-production.yml has no `vercel:` job").toBeGreaterThan(-1);
  const rest = WORKFLOW.slice(at + 1);
  const end = /^ {2}(?:#|[a-z][a-z0-9_-]*:\s*$)/m.exec(rest.slice(rest.indexOf("\n")))?.index;
  return end === undefined ? rest : rest.slice(0, rest.indexOf("\n") + end);
};

describe("the Vercel target is a second target, not a second opinion", () => {
  it("the deploy script and its config both exist", () => {
    expect(existsSync(resolve(REPO_ROOT, "scripts/vercel-deploy.sh"))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, CONFIG_PATH))).toBe(true);
  });

  it("the script is executable", () => {
    // A deploy script without the bit set fails at the moment it is called,
    // which for the production path is after the Fly release has shipped.
    expect(
      statSync(resolve(REPO_ROOT, "scripts/vercel-deploy.sh")).mode & 0o111,
      "scripts/vercel-deploy.sh is not executable",
    ).toBeGreaterThan(0);
  });

  it("parses as bash, and uses nothing newer than bash 3.2", () => {
    // ⚠️ THE ONLY PLACE THIS GETS CHECKED. `.claude/hooks/guard-bash.sh` blocks
    // any command line containing `vercel-deploy.sh`, which is correct — it is a
    // production deploy — and has the side effect that nobody can run `bash -n`
    // on it from a session. So the syntax check lives here, where it runs on
    // every gate instead of never.
    const parsed = spawnSync("bash", ["-n", resolve(REPO_ROOT, "scripts/vercel-deploy.sh")], {
      encoding: "utf8",
    });
    expect(parsed.status, `scripts/vercel-deploy.sh does not parse:\n${parsed.stderr}`).toBe(0);

    // macOS still ships bash 3.2 as /bin/bash and this script is meant to run
    // from the operator's laptop too, so a bash-4 builtin would fail at the one
    // moment someone is deploying by hand. `mapfile`/`readarray` is the one
    // that nearly shipped here.
    const executable = SCRIPT.split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    for (const builtin of ["mapfile", "readarray", "declare -A"]) {
      expect(executable, `scripts/vercel-deploy.sh uses ${builtin} — bash 4+ only`).not.toContain(
        builtin,
      );
    }
  });

  it("the Vercel job runs only after the database job, and never waits for Fly", () => {
    // ⚠️ THE ORDERING IS THE SAFETY PROPERTY. See this file's header, point 1.
    // Exactly `[database]`: a `needs:` that also named the Fly job would put
    // back the coupling [D-177]'s addendum removed — no failover while Fly is
    // down — and one that named neither would race the migrations.
    expect(vercelJob(), "the vercel job does not need exactly the database job").toMatch(
      /^\s{4}needs:\s*\[database\]\s*$/m,
    );
  });

  it("the Vercel job cannot be pointed at a branch that is not production", () => {
    // The same ref guard the Fly job carries. `workflow_dispatch` is a recovery
    // path, and without this it is a way to ship an arbitrary branch as
    // production — to a deployment one `vercel promote` away from the domain.
    expect(vercelJob()).toContain("github.ref == 'refs/heads/production'");
  });

  it("the deploy never assigns the production domain", () => {
    // Point 2. Asserted on the script, which is where the flag lives, AND on
    // the absence of the unguarded form anywhere in it — `--prod` alone would
    // take spiralclass.com.
    expect(SCRIPT, "the deploy does not pass --skip-domain").toContain("--skip-domain");

    const deployLines = SCRIPT.split("\n").filter(
      (line) => !line.trimStart().startsWith("#") && /\bdeploy\b/.test(line),
    );
    for (const line of deployLines) {
      if (!line.includes("--prod")) continue;
      expect(
        line,
        `a production deploy without --skip-domain would take the domain: ${line.trim()}`,
      ).toContain("--skip-domain");
    }
  });

  it("waits on the deployment with a deadline, never on the CLI's own wait", () => {
    // The CLI's wait has no deadline and leaves only on READY, ERROR or
    // CANCELED. Vercel BLOCKED the failover's deployment on 2026-09-18 and the
    // CLI printed "Building…" for the job's whole 30-minute timeout, twice.
    // scripts/vercel-await.mjs fails on every state it does not know to be in
    // progress, and apps/web/tests/scripts/vercel-await.test.ts holds that.
    const executable = SCRIPT.split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    const deploy = executable.split("\n").find((line) => line.includes("deploy --prebuilt"));
    expect(deploy, "no `deploy --prebuilt` line").toBeTruthy();
    expect(deploy, "the deploy waits in the CLI, which has no deadline").toContain("--no-wait");

    const created = executable.indexOf("deploy --prebuilt");
    const awaited = executable.indexOf('node scripts/vercel-await.mjs "$DEPLOYMENT_URL"');
    expect(awaited, "the deployment is never awaited").toBeGreaterThan(created);
    expect(awaited, "the release ledger records the deploy before it has finished").toBeLessThan(
      executable.indexOf("record-release.mjs"),
    );
  });

  it("the Vercel job holds no credential for the database or for Neon", () => {
    // Point 3. Scoped to the job rather than the file, because the job ABOVE it
    // legitimately holds all of these.
    for (const secret of ["DATABASE_URL", "DIRECT_URL", "NEON_API_KEY", "NEON_PROJECT_ID"]) {
      expect(
        vercelJob(),
        `the vercel job is handed ${secret} — it runs no migrations and cuts no checkpoint (D-177)`,
      ).not.toContain(secret);
    }
    // And the Fly token, for the same reason in the other direction: this job
    // has no business redeploying the thing that is serving.
    expect(vercelJob(), "the vercel job is handed FLY_API_TOKEN").not.toContain("FLY_API_TOKEN");
  });

  it("the script runs no migration, cuts no checkpoint and syncs no Inngest app", () => {
    // Each of these is a step scripts/fly-deploy.sh owns for this commit, and
    // the Inngest one is a hazard rather than a duplication: Inngest registers
    // an app PER URL, so syncing a second URL would register a second app and
    // fire every cron twice — once from the thing serving and once from the
    // failover. That bills real Stripe customers twice.
    const executable = SCRIPT.split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    for (const forbidden of [
      "database-deploy.sh",
      "migrate-regions.ts",
      "prisma migrate",
      "neon-checkpoint.sh",
      "inngest-sync.sh",
      "synthetic.sh",
    ]) {
      expect(
        executable,
        `scripts/vercel-deploy.sh runs ${forbidden} — the database job or the Fly deploy owns it for this commit (D-177)`,
      ).not.toContain(forbidden);
    }
  });

  it("the build values come from the same file the Docker build reads", () => {
    // config/env/production.build.env is the one place NEXT_PUBLIC_* values are
    // stated, and they are baked IRREVERSIBLY into the client bundle. A Vercel
    // build that read the dashboard's copy instead would ship different values
    // for the same commit, with nothing failing — so the script calls the same
    // env-build-args.mjs the Dockerfile path calls, and the result REPLACES
    // whatever `vercel pull` brought down. Replaced, not appended to: the
    // project now holds the runtime secrets too, and the Docker build sees none
    // of them, so neither may the Vercel build — nor a file on the runner.
    expect(SCRIPT).toContain("scripts/env-build-args.mjs");
    expect(SCRIPT, "the pulled env file is not replaced, so the dashboard can win").toMatch(
      /\}\s>"\$ENV_FILE"/,
    );
    expect(
      SCRIPT,
      "the pulled env file is appended to, so its runtime values reach the build",
    ).not.toMatch(/>>"\$ENV_FILE"/);
  });

  it("the build gets the Dockerfile's placeholder shapes, exactly, and nothing more", () => {
    // Next's "Collecting page data" validates serverEnv() at module load, so a
    // build with no DATABASE_URL / DIRECT_URL / SESSION_SECRET dies before it
    // connects to anything — the first Vercel build did exactly that. The
    // Dockerfile states the placeholder shapes that get past it; the Vercel
    // build must state the same ones, or a key the schema starts requiring is
    // added to one build and fails the other only on the next release.
    const dockerfile = read("Dockerfile");
    const block = /^ENV DATABASE_URL=[\s\S]*?[^\\]\n/m.exec(dockerfile)?.[0];
    expect(block, "the Dockerfile no longer sets its build-time placeholders").toBeTruthy();
    const docker = Object.fromEntries(
      [...block!.matchAll(/([A-Z_]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
    );
    expect(Object.keys(docker).length).toBeGreaterThan(0);

    // The script writes each placeholder as a literal, single-quoted
    // `echo 'KEY=value'`, and writes nothing else that way.
    const vercel = Object.fromEntries(
      [...SCRIPT.matchAll(/^\s*echo '([A-Z_]+)=([^']*)'$/gm)].map((m) => [m[1], m[2]]),
    );
    expect(vercel).toEqual(docker);
  });

  it("syncs the commit's runtime config before anything is built or deployed", () => {
    // Fly's entrypoint reads config/env/production.runtime.env from the image;
    // Vercel has no entrypoint, so the deploy writes it onto the project from the
    // commit being deployed. A deployment captures the project's variables when
    // it is CREATED, so the sync must come before `deploy` — and it is where the
    // deploy refuses on an unpushed __LOCAL__ secret, so before `build` too,
    // where a refusal costs nothing.
    const executable = SCRIPT.split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    const sync = executable.indexOf("node scripts/vercel-env.mjs sync-committed");
    expect(
      sync,
      "scripts/vercel-deploy.sh does not sync the committed runtime config",
    ).toBeGreaterThan(-1);
    for (const step of ["pull --yes", "build --prod", "deploy --prebuilt"]) {
      const at = executable.indexOf(step);
      expect(at, `no \`${step}\` step`).toBeGreaterThan(-1);
      expect(sync, `the sync runs after \`${step}\``).toBeLessThan(at);
    }
  });

  it("both targets stamp the same deployment id for the same commit", () => {
    // Next's `?dpl=` skew mitigation compares this value. If Fly stamps the SHA
    // and Vercel stamps something else, a client served by Fly before a promote
    // and by Vercel after it sees a skew it must hard-navigate through — on
    // every page, for every visitor, once.
    expect(SCRIPT).toMatch(/NEXT_DEPLOYMENT_ID=\$\{SHA\}/);
    expect(read("scripts", "fly-deploy.sh")).toContain("NEXT_DEPLOYMENT_ID=${SHA}");
  });

  it("the CLI version is pinned, not floating", () => {
    // A deploy whose tool floats is a deploy that can change without a commit —
    // the same argument that SHA-pins every action in .github/workflows.
    expect(SCRIPT).toMatch(/VERCEL_CLI_VERSION="\$\{VERCEL_CLI_VERSION:-\d+\.\d+\.\d+\}"/);
    expect(SCRIPT, "the CLI is fetched at a floating tag").not.toContain("vercel@latest");
  });

  it("the workflow states no CLI version of its own", () => {
    // One pin. A second one here is the copy that stops matching.
    expect(vercelJob()).not.toMatch(/vercel@\d/);
  });
});

describe("the Vercel project config says what it must", () => {
  const config = JSON.parse(read(CONFIG_PATH)) as {
    framework?: string;
    buildCommand?: string;
    outputDirectory?: string;
    regions?: string[];
    git?: { deploymentEnabled?: boolean };
  };

  it("disables git deployments, so no push can deploy without Actions", () => {
    // The second lock on "every deploy runs through GitHub Actions" (D-150's
    // addendum, D-157). The first is that no root vercel.json exists —
    // decommissioned-platforms.test.ts holds that one. Two locks, because the
    // failure is a second unreviewed path to production.
    expect(config.git?.deploymentEnabled).toBe(false);
  });

  it("builds through the workspace's own build script", () => {
    // apps/web/package.json owns what building means, here as in the Dockerfile.
    // A retyped `next build` here would be a second definition, and the one most
    // likely to miss `prisma generate`.
    expect(config.buildCommand).toBe("pnpm --filter spiralclass-web build");
  });

  it("pins the function region to the one D-150 measured", () => {
    // ⚠️ `cle1` is Cleveland, us-east-2 — Ohio, where D-150 found Neon. That
    // record's entire argument was 58 ms from Querétaro against 12 ms from Fly
    // `ord`, times twenty-eight round trips on a database-heavy page. A function
    // in the wrong region re-introduces exactly that latency, silently.
    //
    // ⚠️ AND IT IS AN UNVERIFIED PREMISE, recorded as one. The Neon project's
    // region is not committed anywhere in this tree — the publication sweep
    // removed the identifier (D-158) — so this pins what D-150 says rather than
    // what anyone checked. Confirm with `neonctl projects list` before this
    // target takes the domain; if the answer is not us-east-2, change the config
    // and this assertion together.
    expect(config.regions).toEqual(["cle1"]);
  });

  it("does not set output: standalone, which is the Dockerfile's mode", () => {
    // next.config.ts sets `output: "standalone"` only on BUILD_STANDALONE=1.
    // Vercel's builder wants the ordinary build, and the fact that this needed
    // no config fork is the evidence for D-150's "the application is already
    // provider-neutral".
    // Asserted on an ASSIGNMENT rather than on the name. The script's progress
    // line says "no BUILD_STANDALONE — this is Vercel's builder, not the
    // Dockerfile", which is the sentence a reader most needs and which a
    // bare-name check would forbid. A guard that cannot tell a setting from the
    // note explaining its absence is one people delete.
    const executable = SCRIPT.split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(executable, "the Vercel build sets BUILD_STANDALONE").not.toMatch(
      /(^|\s|export\s+)BUILD_STANDALONE=/m,
    );
  });
});
