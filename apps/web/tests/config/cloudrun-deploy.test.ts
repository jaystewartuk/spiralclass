import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { composeEnvFile, namesOf } from "../../../../scripts/cloudrun-env.mjs";
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

/**
 * The Cloud Run target ([D-184]) — the third production target, and the one
 * built to take the domain from Fly.
 *
 * Most of what makes it safe is a value in a config file or a flag in a shell
 * script, and none of those fail a build when they go. The parts that would
 * cost real money or real correctness, in the order they would:
 *
 *   * The service shape. 512Mi wedged production in a 503 loop once already,
 *     and the region was chosen from a measurement rather than from a map.
 *   * The secret mount. Secrets reach the container as a FILE, so that the
 *     deploy identity never needs to read them and no value ever lands in argv.
 *   * The entrypoint's half of that mount, which is the only genuinely new
 *     RUNTIME behaviour in the change — and which Fly's boot must not notice.
 */

const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

const SCRIPT_PATH = "scripts/cloudrun-deploy.sh";
const SCRIPT = read(SCRIPT_PATH);
/** The script with its comments stripped — a comment may name what it avoids. */
const EXECUTABLE = SCRIPT.split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");
const SHAPE_PATH = "config/cloudrun/production.env";
const SHAPE = read(SHAPE_PATH);
const ENTRYPOINT_PATH = "scripts/docker-entrypoint.sh";

/** `KEY=value` from the shape file, comments and blanks dropped. */
const shape = Object.fromEntries(
  SHAPE.split("\n")
    .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => [m[1], m[2]]),
);

describe("the service shape is the one that was measured", () => {
  it("the script, its config and the operator's scripts all exist", () => {
    for (const path of [
      SCRIPT_PATH,
      SHAPE_PATH,
      "scripts/cloudrun-env.mjs",
      "infra/gcp/README.md",
      "infra/gcp/setup-deploy-identity.sh",
      "infra/gcp/push-cloudrun-env.sh",
    ]) {
      expect(existsSync(resolve(REPO_ROOT, path)), `${path} is missing`).toBe(true);
    }
  });

  it("asks for at least 1Gi — 512Mi is the size that wedged production", () => {
    // 2026-08-26: Committed_AS ~540MB against MemTotal 470MB, no swap, so Node
    // sat at the ceiling GC-thrashing and the health check flapped. The same
    // process runs here.
    expect(shape.MEMORY).toBe("1Gi");
  });

  it("runs in us-east4, the region the latency measurement picked", () => {
    // us-east5 is physically in Ohio, beside the database, and measured the
    // same 21ms — the inter-cloud path is not the map. us-east4 wins the
    // tiebreak on custom domain mapping, which the cutover needs.
    expect(shape.REGION).toBe("us-east4");
  });

  it("scales to zero and caps how far it can scale up", () => {
    // Scale-to-zero is what makes it free. MAX_INSTANCES is the only thing
    // bounding a crawl or a loop, because Cloud Run has no hard spending cap.
    expect(shape.MIN_INSTANCES).toBe("0");
    expect(Number(shape.MAX_INSTANCES)).toBeGreaterThan(0);
    expect(Number(shape.MAX_INSTANCES)).toBeLessThanOrEqual(10);
  });

  it("names no account identifier — this repository is public (D-158)", () => {
    // The project id reaches the deploy as a secret. A project id here would be
    // published on the next push, and could not be taken back.
    expect(SHAPE).not.toContain("GCP_PROJECT_ID=");
    expect(SHAPE, "a service-account email carries the project id").not.toMatch(
      /@[a-z0-9-]+\.iam\.gserviceaccount\.com/,
    );
    expect(shape.RUNTIME_SA_ID, "the runtime identity is the local part only").not.toContain("@");
  });

  it("passes the shape on every deploy, so a console edit cannot outlive it", () => {
    // fly.production.toml's `[[vm]]` block learned this the hard way: a
    // hand-scaled fix that the next deploy silently reverts is how the same
    // outage comes back a week later.
    for (const flag of ["--cpu", "--memory", "--min-instances", "--max-instances"]) {
      expect(SCRIPT, `the deploy does not pass ${flag}`).toContain(flag);
    }
  });
});

describe("the deploy can ship production and cannot read it", () => {
  it("mounts the secrets as a file and never explodes them into env vars", () => {
    // --set-env-vars would put every value in argv (D-66) AND require the
    // deploy identity to hold them. --set-secrets names the secret; only the
    // runtime service account can read it.
    expect(EXECUTABLE).toContain("--set-secrets");
    expect(EXECUTABLE).toContain("SECRETS_ENV_FILE=");
    // --set-env-vars REPLACES the service's whole environment. --update-env-vars
    // merges, which is what keeps a one-off override alive across a deploy.
    expect(
      EXECUTABLE,
      "the deploy uses --set-env-vars, which replaces the service environment",
    ).not.toContain("--set-env-vars");
    expect(EXECUTABLE).toContain("--update-env-vars");
  });

  it("runs as a dedicated identity, not Compute Engine's default", () => {
    // The default compute service account usually carries project-wide Editor.
    // This app needs no Google API at all.
    expect(SCRIPT).toContain("--service-account");
    expect(shape.RUNTIME_SA_ID).toBeTruthy();
  });

  it("the operator scripts read the shape file rather than retyping it", () => {
    // The class of bug this catches, found once in each script: a literal here
    // that stops matching config/cloudrun/production.env creates one account
    // and binds another, or writes a version of a secret nothing mounts. Both
    // report success. The second is the worse one — a rotation that looks done
    // and leaves the running service on the old values.
    //
    // Checked by VALUE, not by name: every value the shape file defines must
    // reach these scripts through the variable, so a future key added to the
    // config is covered here without widening a list.
    const DERIVED = ["SECRET_NAME", "RUNTIME_SA_ID", "REGION", "ARTIFACT_REPO"] as const;
    for (const file of ["infra/gcp/setup-deploy-identity.sh", "infra/gcp/push-cloudrun-env.sh"]) {
      const executable = read(file)
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      expect(executable, `${file} does not read ${SHAPE_PATH}`).toContain("config/cloudrun/");
      for (const key of DERIVED) {
        const literal = shape[key];
        if (!literal) continue;
        // Matched as a whole ARGUMENT, not as a substring. The first version
        // looked for the value anywhere on the line and duly fired on
        // `--display-name="spiralclass — alert, not a cap"`, where the word is
        // prose about the product rather than a retyped repository name. What
        // this is for is a value that must MATCH the config to work; a human
        // label is not one, and a test that cannot tell the difference gets
        // satisfied by contorting the label.
        const spelled = executable
          .split("\n")
          .filter((line) => !line.includes(`$${key}`))
          .filter((line) => !new RegExp(`^\\s*${key}=`).test(line.trim()))
          .filter((line) =>
            line.split(/\s+/).some((token) => token.replace(/^["']|["'\\]+$/g, "") === literal),
          );
        expect(spelled, `${file} hardcodes ${key}'s value (${literal}) instead of $${key}`).toEqual(
          [],
        );
      }
    }
  });

  it("keeps enough images to roll back, and prunes the rest", () => {
    // Artifact Registry's free allowance is 0.5 GB and every release pushes
    // another image; nothing prunes them on its own, so this is the line item
    // most likely to start charging. It is also the one that must not be
    // over-tuned: a Cloud Run rollback re-points at an earlier revision, whose
    // IMAGE has to still exist, so the keep count is a rollback depth.
    const policy = JSON.parse(read("config", "cloudrun", "artifact-cleanup.json")) as Array<{
      name: string;
      action: { type: string };
      mostRecentVersions?: { keepCount: number };
      condition?: { tagState?: string; olderThan?: string };
    }>;

    const keep = policy.find((rule) => rule.action.type === "Keep");
    expect(keep, "no Keep rule — every image would age out and rollback would break").toBeTruthy();
    expect(keep!.mostRecentVersions?.keepCount).toBeGreaterThanOrEqual(3);

    // The other half: a Keep rule alone prunes nothing, which is the shape that
    // looks configured and bills anyway.
    expect(
      policy.some((rule) => rule.action.type === "Delete"),
      "the policy keeps images and deletes none",
    ).toBe(true);

    // The setup script must actually apply it — a committed policy no command
    // references is a file that reads as protection and is not.
    const setup = read("infra/gcp/setup-deploy-identity.sh");
    expect(setup).toContain("set-cleanup-policies");
    expect(setup).toContain("config/cloudrun/artifact-cleanup.json");
    expect(setup, "a dry-run policy reports what it would delete and deletes nothing").toContain(
      "--no-dry-run",
    );
  });

  it("asks for a key and a budget only when there is none", () => {
    // The script is the recovery path for a partial failure, so it is meant to
    // be re-run. The first version ended every run by saying "mint a key",
    // including runs where the key existed and CI was using it — advice that
    // leaves an operator with two valid keys and nothing to say which to
    // revoke. Same shape for the budget, hedged in prose ("if no budget is
    // listed above") where the script already knew the answer.
    // Comments only, stripped: the header explains the rotation procedure and
    // names the same command, which is documentation rather than a run of it.
    const setup = read("infra/gcp/setup-deploy-identity.sh")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    for (const [count, command] of [
      ["EXISTING_KEYS", "keys create -"],
      ["EXISTING_BUDGETS", "budgets create"],
    ]) {
      const counted = setup.indexOf(`${count}="$(`);
      const branched = setup.indexOf(`if [ "$${count}" = "0" ]`);
      const asked = setup.indexOf(command);
      expect(counted, `${count} is never counted`).toBeGreaterThan(-1);
      expect(branched, `nothing branches on ${count}`).toBeGreaterThan(-1);
      expect(counted, `${count} is used before it is counted`).toBeLessThan(branched);
      expect(branched, `\`${command}\` is printed before the ${count} check`).toBeLessThan(asked);
    }
  });

  it("bounds what an unusual month can cost, without a cap that would cause an outage", () => {
    // Cloud Run has no hard spending cap. MAX_INSTANCES is the only thing
    // bounding a crawl or a loop, and the budget alert is the only thing that
    // says so early. A cap that stopped the service would trade a bill for an
    // outage on a payments app, which is why the alert is the softer half and
    // the ceiling is the hard one.
    expect(Number(shape.MAX_INSTANCES)).toBeLessThanOrEqual(10);
    const setup = read("infra/gcp/setup-deploy-identity.sh");
    expect(setup).toContain("budgets");
  });

  it("that check still catches a real retype, and is not merely passing", () => {
    // The check above was loosened once, to stop it firing on a human label
    // that happened to contain the word. Loosening a check is exactly when it
    // can quietly stop catching anything — so this runs the same predicate over
    // a line that IS the bug, and fails if it is let through.
    const spelled = (line: string, key: string, literal: string) =>
      [line]
        .filter((l) => !l.includes(`$${key}`))
        .filter((l) => !new RegExp(`^\\s*${key}=`).test(l.trim()))
        .filter((l) =>
          l.split(/\s+/).some((token) => token.replace(/^["']|["'\\]+$/g, "") === literal),
        );

    const repo = shape.ARTIFACT_REPO;
    expect(
      spelled(
        `gcloud artifacts repositories create ${repo} --location=us-east4`,
        "ARTIFACT_REPO",
        repo,
      ),
      "a hardcoded repository name is no longer caught",
    ).toHaveLength(1);
    expect(
      spelled(`gcloud artifacts repositories create "$ARTIFACT_REPO"`, "ARTIFACT_REPO", repo),
      "the correct form is reported as a retype",
    ).toHaveLength(0);
    expect(
      spelled(`--display-name="${repo} — alert, not a cap"`, "ARTIFACT_REPO", repo),
      "a human label containing the word is reported as a retype",
    ).toHaveLength(0);
  });

  it("the cutover runbook D-184 points at actually exists", () => {
    // D-184 shipped saying "the cutover ... is in
    // docs/deployment/RELEASE_AND_STAGING.md", and it was not — a merged
    // decision record pointing at a procedure nobody had written. That is the
    // failure CLAUDE.md's fourth rule is about, and a cross-reference is
    // exactly the kind of claim that rots silently, because the document it
    // names still exists and still looks right.
    const record = read("docs/decisions/D-184.md");
    const runbook = read("docs/deployment/RELEASE_AND_STAGING.md");

    expect(record, "D-184 no longer points at the runbook").toContain("RELEASE_AND_STAGING.md");
    expect(runbook, "the runbook has no Cloud Run section").toMatch(/^## Cloud Run/m);

    // The two steps that cost real money if skipped, asserted by name rather
    // than by count: a runbook that lost either of them would still read as a
    // procedure.
    expect(runbook, "the runbook does not cover taking the domain").toContain("domain-mappings");
    expect(runbook, "the runbook does not warn about Inngest's per-URL registration").toMatch(
      /Inngest registers an app \*\*per URL\*\*/,
    );
  });

  it("never grants the deploy identity read access to the secret", () => {
    const setup = read("infra/gcp/setup-deploy-identity.sh");
    const accessorGrants = setup
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
      .match(/secretAccessor[\s\S]{0,200}?(?=\n\n|$)/g);
    expect(accessorGrants, "nothing is granted secretAccessor at all").not.toBeNull();
    for (const grant of accessorGrants ?? []) {
      expect(grant, "the DEPLOY account was granted secretAccessor").not.toContain("DEPLOY_SA");
    }
  });

  it("takes no domain, syncs no Inngest app and touches no database", () => {
    // Each of these is a whole class of incident. The Inngest one is the
    // sharpest: Inngest registers an app per URL, so a second synced URL fires
    // every cron twice — including ones that bill Stripe customers.
    expect(EXECUTABLE).not.toContain("domain-mappings");
    expect(EXECUTABLE).not.toContain("inngest-sync");
    expect(EXECUTABLE).not.toContain("database-deploy");
  });
});

describe("the script refuses before it touches anything", () => {
  const scratch = mkdtempSync(join(tmpdir(), "cloudrun-deploy-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** An environment built from nothing — no token, no inherited gcloud login. */
  const run = (args: string[]) =>
    spawnSync("bash", [SCRIPT_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { HOME: scratch, PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
    });

  it.each([SCRIPT_PATH, "infra/gcp/setup-deploy-identity.sh", "infra/gcp/push-cloudrun-env.sh"])(
    "%s parses",
    (path) => {
      // The operator scripts are checked here because they cannot be checked
      // anywhere else: `.claude/hooks/guard-bash.sh` blocks a command line that
      // names them, so `bash -n` on one is refused in a session. They run rarely,
      // by hand, against live infrastructure — exactly the shape where a syntax
      // error is found at the worst possible moment.
      const parsed = spawnSync("bash", ["-n", join(REPO_ROOT, path)], { encoding: "utf8" });
      expect(parsed.status, parsed.stderr).toBe(0);
    },
  );

  it("names no default environment", () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage:");
  });

  it("refuses an environment that is not production", () => {
    // Preview belongs to Fly (D-150's addendum). A second service would be a
    // second thing to keep in sync for no stated reason.
    const result = run(["preview", "--gate-already-passed"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage:");
  });

  it("refuses production without the promote gate's handoff", () => {
    const result = run(["production"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("without the full promote gate");
  });

  it("refuses a misspelt flag rather than deploying without the gate", () => {
    const result = run(["production", "--gate-alredy-passed"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown argument");
  });

  it("refuses a missing project id before building anything", () => {
    const result = run(["production", "--gate-already-passed"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GCP_PROJECT_ID");
    expect(result.stdout, "it started a build").not.toContain("Deploying");
  });
});

describe("the entrypoint's secret file — the one new runtime behaviour", () => {
  const scratch = mkdtempSync(join(tmpdir(), "cloudrun-entrypoint-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  // A committed runtime file of the shape config/env/<env>.runtime.env has,
  // including a __LOCAL__ whose real value is deliberately not in git.
  writeFileSync(join(scratch, "runtime.env"), "FROM_COMMITTED=yes\nSECRET_ONE=__LOCAL__\n");
  writeFileSync(
    join(scratch, "secrets.env"),
    "DATABASE_URL=postgresql://from-secret/x\nSECRET_ONE=filled\n",
  );

  const entrypoint = join(scratch, "entrypoint.sh");
  writeFileSync(
    entrypoint,
    read(ENTRYPOINT_PATH).replace(
      'env_file="config/env/${APP_ENV:-}.runtime.env"',
      `env_file="${join(scratch, "runtime.env")}"`,
    ),
  );
  chmodSync(entrypoint, 0o755);

  /** Boots the entrypoint with `env` as the command, and returns what it exported. */
  const boot = (vars: Record<string, string>) => {
    const result = spawnSync("sh", [entrypoint, "env"], {
      encoding: "utf8",
      env: { APP_ENV: "production", ...vars } as unknown as NodeJS.ProcessEnv,
    });
    const exported = Object.fromEntries(
      result.stdout
        .split("\n")
        .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line))
        .filter((m): m is RegExpExecArray => Boolean(m))
        .map((m) => [m[1], m[2]]),
    );
    return { ...result, exported };
  };

  it("Fly's boot is untouched — no SECRETS_ENV_FILE, no secret block", () => {
    // The whole point of the guard: this change must be invisible on the
    // platform that is still serving the domain.
    const result = boot({});
    expect(result.status).toBe(0);
    expect(result.exported.FROM_COMMITTED).toBe("yes");
    expect(result.exported.DATABASE_URL).toBeUndefined();
    expect(result.stderr).not.toContain("sourcing secrets");
  });

  it("sources the file when one is mounted", () => {
    const result = boot({ SECRETS_ENV_FILE: join(scratch, "secrets.env") });
    expect(result.status).toBe(0);
    expect(result.exported.DATABASE_URL).toBe("postgresql://from-secret/x");
    expect(result.exported.FROM_COMMITTED).toBe("yes");
  });

  it("a secret fills a __LOCAL__ the committed file left unset", () => {
    // Same relationship the Fly secrets have with the committed file: the
    // placeholder says "not in git", and the secret is where the value lives.
    expect(boot({}).exported.SECRET_ONE).toBeUndefined();
    expect(boot({ SECRETS_ENV_FILE: join(scratch, "secrets.env") }).exported.SECRET_ONE).toBe(
      "filled",
    );
  });

  it("the container environment still wins over the file", () => {
    const result = boot({
      SECRETS_ENV_FILE: join(scratch, "secrets.env"),
      DATABASE_URL: "postgresql://override/x",
    });
    expect(result.exported.DATABASE_URL).toBe("postgresql://override/x");
  });

  it("fails loudly when the mount is named but absent", () => {
    // Booting on would fail Zod's parse at the first request instead — a 503
    // loop that says nothing about why.
    const result = boot({ SECRETS_ENV_FILE: join(scratch, "not-there.env") });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is set but not present");
  });
});

describe("the composed secret file", () => {
  const entries = (pairs: Record<string, string>) =>
    new Map(Object.entries(pairs).map(([key, value]) => [key, { value, owner: "test" }]));

  it("writes one KEY=value line per name, sorted", () => {
    const text = composeEnvFile(entries({ ZED: "3", ALPHA: "1" }));
    const lines = text.split("\n").filter((line) => line && !line.startsWith("#"));
    expect(lines).toEqual(["ALPHA=1", "ZED=3"]);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("preserves a value containing an = sign", () => {
    // Base64 padding and connection strings both do this, and the entrypoint
    // splits on the FIRST = only.
    const text = composeEnvFile(entries({ TOKEN: "abc==def" }));
    expect(text).toContain("TOKEN=abc==def");
  });

  it("preserves an empty value rather than dropping the key", () => {
    expect(composeEnvFile(entries({ EMPTY: "" }))).toContain("EMPTY=");
  });

  it("refuses a newline, which the entrypoint's grammar cannot represent", () => {
    // It would silently truncate the key and turn the rest of the value into
    // garbage lines — surfacing later as a Zod error pointing at the wrong var.
    expect(() => composeEnvFile(entries({ KEY: "one\ntwo" }))).toThrow(/newline/);
    expect(() => composeEnvFile(entries({ KEY: "one\rtwo" }))).toThrow(/newline/);
  });

  it("reports names without reporting any value", () => {
    const desired = entries({ B: "secret-b", A: "secret-a" });
    expect(namesOf(desired)).toEqual(["A", "B"]);
    expect(namesOf(desired).join()).not.toContain("secret");
  });
});
