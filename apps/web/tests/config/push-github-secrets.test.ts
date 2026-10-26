import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { REPO_ROOT } from "./_tree";

/**
 * `infra/infisical/push-github-secrets.sh` used to only ever add (#106). It
 * derived the names from the deploy workflow, set each from Infisical and
 * verified each was listed — and a secret the workflow stopped reading stayed
 * in the `production` environment for good, readable by any job that later
 * named it. D-163 calls the GitHub copy derived; add-only, that was true of
 * values and false of names.
 *
 * Since D-205 the deploy's two jobs read two environments — the database job
 * `production`, the Cloud Run job `production-app` — so each name goes to the
 * environment of the job that reads it, and a name on an environment its own
 * job does not read is stale there, even when the other job reads it.
 *
 * The script is operator-only and talks to Infisical and GitHub, so it is run
 * here against stubs: a copy of the three `infra/infisical` files in a scratch
 * tree beside a workflow this file writes, with `infisical` and `gh` replaced
 * by scripts that log every call and keep each environment's secret names in a
 * file. `jq` is the real one, as it is on the operator's laptop and the runner.
 * Nothing here reaches a network or a real credential.
 */

const SCRIPT = join("infra", "infisical", "push-github-secrets.sh");
const REPO = "owner/name";
const DB = "production";
const APP = "production-app";

/** What each fixture job reads. GITHUB_TOKEN is minted per run, never pushed. */
const READ: Record<string, string[]> = {
  [DB]: ["NEON_API_KEY"],
  [APP]: ["GCP_DEPLOY_KEY", "NEXT_PUBLIC_APP_URL"],
};
/** The #105 incident's name: on the environment, no longer read by the workflow. */
const STALE = "NEXT_PUBLIC_SUPPORT_WHATSAPP";

const VALUES: Record<string, string> = {
  GCP_DEPLOY_KEY: "stub-gcp-value",
  NEON_API_KEY: "stub-neon-value",
  NEXT_PUBLIC_APP_URL: "https://stub.example",
};

const scratch = mkdtempSync(join(tmpdir(), "push-github-secrets-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const tree = join(scratch, "repo");
const bin = join(scratch, "bin");
const log = join(scratch, "calls.log");
const held = join(scratch, "held");
const workflowPath = join(tree, ".github", "workflows", "deploy-production.yml");

mkdirSync(join(tree, "infra", "infisical"), { recursive: true });
mkdirSync(join(tree, ".github", "workflows"), { recursive: true });
mkdirSync(bin, { recursive: true });

// The script plus the two files it sources, as they are in this checkout.
for (const file of ["push-github-secrets.sh", "infisical.sh", "project-id.sh"]) {
  copyFileSync(join(REPO_ROOT, "infra", "infisical", file), join(tree, "infra", "infisical", file));
}

const envLines = (names: string[]) => names.map((name) => `      ${name}: \${{ secrets.${name} }}`);

/**
 * Both spellings of a job's environment, as deploy-production.yml uses them: a
 * bare `environment: X`, and `environment:` with `name:` and `url:` beneath.
 * The comment carries a `${{ secrets.X }}` example the parse must not read.
 */
const WORKFLOW = [
  "# An unset `${{ secrets.X }}` is the empty string.",
  "on:",
  "  push:",
  "jobs:",
  "  database:",
  `    environment: ${DB}`,
  "    env:",
  ...envLines(READ[DB]),
  "  cloudrun:",
  "    needs: [database]",
  "    environment:",
  `      name: ${APP}`,
  "      url: https://stub.example",
  "    env:",
  ...envLines(READ[APP]),
  "      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
  "",
].join("\n");

const stub = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};

// Every value at `/`; the other two paths empty, which infisical_env accepts.
stub(
  "infisical",
  `for arg in "$@"; do
  [ "$arg" = "--path=/" ] && { echo '${JSON.stringify(
    Object.entries(VALUES).map(([key, value]) => ({ key, value })),
  )}'; exit 0; }
done
echo '[]'`,
);

// `secret set NAME --repo R --env E` reads its value from stdin and records the
// name in E's file; `secret list --repo R --env E` prints E's names; `delete`
// removes one — unless STUB_DELETE_NOOP, a GitHub that accepts a delete and
// goes on listing the name.
stub(
  "gh",
  `case "$1 $2" in
  "secret set") cat >/dev/null; f="$STUB_HELD.$7"; touch "$f"; grep -qxF "$3" "$f" || echo "$3" >> "$f" ;;
  "secret list") f="$STUB_HELD.$6"; touch "$f"; cat "$f" ;;
  "secret delete")
    [ -n "$STUB_DELETE_NOOP" ] && exit 0
    f="$STUB_HELD.$7"; grep -vxF "$3" "$f" > "$f.tmp"; mv "$f.tmp" "$f" ;;
  *) echo "stub gh: unexpected call: $*" >&2; exit 97 ;;
esac`,
);

/** An environment's names, as the stub `gh` holds them. */
const heldNames = (env: string) => {
  const file = `${held}.${env}`;
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).sort() : [];
};
const hold = (env: string, names: string[]) =>
  writeFileSync(`${held}.${env}`, names.map((name) => `${name}\n`).join(""));

/**
 * Run the script from an environment built from nothing but PATH (stubs first),
 * HOME, the stubs' state and a project id the wrapper's hash check is told to
 * skip — the one it would compare against belongs to the real project.
 */
const push = (args: string[], extra: Record<string, string> = {}) => {
  writeFileSync(log, "");
  const result = spawnSync("bash", [join(tree, SCRIPT), ...args], {
    cwd: scratch,
    encoding: "utf8",
    env: {
      HOME: scratch,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      REPO,
      STUB_LOG: log,
      STUB_HELD: held,
      INFISICAL_PROJECT_ID: "stub-project",
      INFISICAL_SKIP_PROJECT_CHECK: "1",
      ...extra,
    } as unknown as NodeJS.ProcessEnv,
  });
  return { ...result, calls: readFileSync(log, "utf8") };
};

/**
 * The names listed under an environment's stale-names heading, up to the first
 * line that is not an indented bare name. Empty when there is no heading.
 */
const reported = (stderr: string, env: string) => {
  const [, after] = stderr.split(
    `On \`${env}\` but not read by its job in .github/workflows/deploy-production.yml:\n`,
  );
  if (after === undefined) return [];
  const names: string[] = [];
  for (const line of after.split("\n")) {
    const match = /^ {4}([A-Za-z0-9_]+)$/.exec(line);
    if (!match) break;
    names.push(match[1]);
  }
  return names;
};

const setCall = (name: string, env: string) =>
  `gh secret set ${name} --repo ${REPO} --env ${env}\n`;
const deleteCall = (name: string, env: string) =>
  `gh secret delete ${name} --repo ${REPO} --env ${env}\n`;

beforeEach(() => {
  writeFileSync(workflowPath, WORKFLOW);
  // Before D-205: the GCP key on `production`, beside the #105 stale name, and
  // `production-app` empty.
  hold(DB, ["GCP_DEPLOY_KEY", STALE]);
  hold(APP, []);
});

describe("push-github-secrets.sh pushes each name to its own job's environment (D-205)", () => {
  it("parses", () => {
    const parsed = spawnSync("bash", ["-n", join(REPO_ROOT, SCRIPT)], { encoding: "utf8" });
    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it("sets every name on the environment of the job that reads it, and nowhere else", () => {
    const result = push([]);
    expect(result.status, result.stderr).toBe(0);
    for (const [env, names] of Object.entries(READ)) {
      const other = env === DB ? APP : DB;
      for (const name of names) {
        expect(result.calls).toContain(setCall(name, env));
        expect(result.calls).not.toContain(setCall(name, other));
      }
    }
    expect(result.calls).not.toContain("GITHUB_TOKEN");
    expect(result.calls).not.toContain("secret set X ");
    expect(heldNames(APP)).toEqual([...READ[APP]].sort());
  });

  it("refuses a job that reads secrets with no environment, before reading or pushing anything", () => {
    writeFileSync(workflowPath, WORKFLOW.replace(`    environment: ${DB}\n`, ""));
    const result = push([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("declares no environment");
    expect(result.stderr).toContain("    NEON_API_KEY");
    expect(result.calls).not.toContain("secret set");
    expect(result.calls).not.toContain("infisical");
  });

  it("pushes nothing when a value is missing from Infisical", () => {
    writeFileSync(workflowPath, WORKFLOW.replaceAll("NEON_API_KEY", "NOT_IN_INFISICAL"));
    const result = push([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NOT_IN_INFISICAL");
    expect(result.calls).not.toContain("secret set");
  });
});

describe("push-github-secrets.sh reports the names an environment's job no longer reads (#106)", () => {
  it("refuses a misspelt flag before reading or pushing anything", () => {
    const result = push(["--delete-stail"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown argument: --delete-stail");
    expect(result.stderr).toContain("usage:");
    expect(result.calls).toBe("");
    expect(heldNames(DB)).toEqual(["GCP_DEPLOY_KEY", STALE].sort());
  });

  it("without --delete-stale, reports stale names, deletes nothing and exits 0", () => {
    const result = push([]);
    expect(result.status, result.stderr).toBe(0);
    // The GCP key is read — by the other job — so it is stale HERE.
    expect(reported(result.stderr, DB)).toEqual(["GCP_DEPLOY_KEY", STALE]);
    expect(reported(result.stderr, APP)).toEqual([]);
    expect(result.stderr).toContain("Nothing was deleted");
    expect(result.calls).not.toContain("secret delete");
    expect(heldNames(DB)).toContain(STALE);
  });

  it("with --delete-stale, deletes them from that environment only", () => {
    const result = push(["--delete-stale"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain(deleteCall(STALE, DB));
    expect(result.calls).toContain(deleteCall("GCP_DEPLOY_KEY", DB));
    expect(result.calls).not.toContain(deleteCall("GCP_DEPLOY_KEY", APP));
    expect(heldNames(DB)).toEqual([...READ[DB]].sort());
    expect(heldNames(APP)).toEqual([...READ[APP]].sort());
  });

  it("never deletes, or reports, a name an environment's own job reads", () => {
    const result = push(["--delete-stale"]);
    expect(result.status, result.stderr).toBe(0);
    for (const [env, names] of Object.entries(READ)) {
      for (const name of names) {
        expect(result.calls, `${name} deleted from ${env}`).not.toContain(deleteCall(name, env));
        expect(reported(result.stderr, env)).not.toContain(name);
      }
    }
    expect(result.calls.match(/secret delete/g)).toHaveLength(2);
  });

  it("says nothing about stale names when there are none", () => {
    hold(DB, []);
    const result = push(["--delete-stale"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("not read by");
    expect(result.calls).not.toContain("secret delete");
    expect(heldNames(DB)).toEqual([...READ[DB]].sort());
  });

  it("fails when GitHub still lists a name it was told to delete", () => {
    const result = push(["--delete-stale"], { STUB_DELETE_NOOP: "1" });
    expect(result.status).toBe(1);
    expect(result.calls).toContain(deleteCall(STALE, DB));
    expect(result.stderr).toContain("Deleted, but GitHub still lists");
  });

  it("keeps values off argv while doing it", () => {
    const result = push(["--delete-stale"]);
    expect(result.status, result.stderr).toBe(0);
    for (const value of Object.values(VALUES)) {
      expect(result.calls).not.toContain(value);
    }
  });
});

describe("the real deploy workflow, as this script reads it", () => {
  it("puts the database values on production and the Cloud Run values on production-app", () => {
    writeFileSync(
      workflowPath,
      readFileSync(join(REPO_ROOT, ".github", "workflows", "deploy-production.yml"), "utf8"),
    );
    // Any value: the stub answers only the three above, so the run stops at
    // the missing-values check, after printing the parse and before pushing.
    const result = push([]);
    expect(result.calls).not.toContain("secret set");
    const section = (env: string) => {
      const names: string[] = [];
      for (const line of result.stderr.split(`    \`${env}\`:\n`)[1]?.split("\n") ?? []) {
        if (!/^ {6}\S/.test(line)) break;
        names.push(line.trim());
      }
      return names;
    };
    expect(section(DB)).toEqual(["DATABASE_URL", "DIRECT_URL", "NEON_API_KEY", "NEON_PROJECT_ID"]);
    expect(section(APP)).toContain("GCP_DEPLOY_KEY");
    expect(section(APP)).toContain("GCP_PROJECT_ID");
    expect(section(APP)).not.toContain("DATABASE_URL");
  });
});
