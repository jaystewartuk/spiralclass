import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
 * The script is operator-only and talks to Infisical and GitHub, so it is run
 * here against stubs: a copy of the three `infra/infisical` files in a scratch
 * tree beside a workflow this file writes, with `infisical` and `gh` replaced
 * by scripts that log every call and keep the environment's secret names in a
 * file. `jq` is the real one, as it is on the operator's laptop and the runner.
 * Nothing here reaches a network or a real credential.
 */

const SCRIPT = join("infra", "infisical", "push-github-secrets.sh");
const REPO = "owner/name";

/** What the fixture workflow reads. GITHUB_TOKEN is minted per run, never pushed. */
const READ = ["GCP_DEPLOY_KEY", "NEON_API_KEY", "NEXT_PUBLIC_APP_URL"];
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
const held = join(scratch, "held.txt");

mkdirSync(join(tree, "infra", "infisical"), { recursive: true });
mkdirSync(join(tree, ".github", "workflows"), { recursive: true });
mkdirSync(bin, { recursive: true });

// The script plus the two files it sources, as they are in this checkout.
for (const file of ["push-github-secrets.sh", "infisical.sh", "project-id.sh"]) {
  copyFileSync(join(REPO_ROOT, "infra", "infisical", file), join(tree, "infra", "infisical", file));
}

writeFileSync(
  join(tree, ".github", "workflows", "deploy-production.yml"),
  [
    "jobs:",
    "  deploy:",
    "    environment: production",
    "    env:",
    ...READ.map((name) => `      ${name}: \${{ secrets.${name} }}`),
    "      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "",
  ].join("\n"),
);

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

// `secret set` reads its value from stdin and records the name; `list` prints
// the names; `delete` removes one — unless STUB_DELETE_NOOP, a GitHub that
// accepts a delete and goes on listing the name.
stub(
  "gh",
  `case "$1 $2" in
  "secret set") cat >/dev/null; grep -qxF "$3" "$STUB_HELD" || echo "$3" >> "$STUB_HELD" ;;
  "secret list") cat "$STUB_HELD" ;;
  "secret delete")
    [ -n "$STUB_DELETE_NOOP" ] && exit 0
    grep -vxF "$3" "$STUB_HELD" > "$STUB_HELD.tmp"; mv "$STUB_HELD.tmp" "$STUB_HELD" ;;
  *) echo "stub gh: unexpected call: $*" >&2; exit 97 ;;
esac`,
);

/** The environment's names, as the stub `gh` holds them. */
const heldNames = () => readFileSync(held, "utf8").split("\n").filter(Boolean).sort();

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
 * The names listed under the stale-names heading, up to the first line that is
 * not an indented bare name. Empty when there is no heading.
 */
const reported = (stderr: string) => {
  const [, after] = stderr.split("not read by .github/workflows/deploy-production.yml:\n");
  if (after === undefined) return [];
  const names: string[] = [];
  for (const line of after.split("\n")) {
    const match = /^ {4}([A-Za-z0-9_]+)$/.exec(line);
    if (!match) break;
    names.push(match[1]);
  }
  return names;
};

const deleteCall = (name: string) => `gh secret delete ${name} --repo ${REPO} --env production`;

describe("push-github-secrets.sh reports the names the workflow no longer reads (#106)", () => {
  beforeEach(() => {
    // One name the workflow reads is already there; the stale one is too.
    writeFileSync(held, `GCP_DEPLOY_KEY\n${STALE}\n`);
  });

  it("parses", () => {
    const parsed = spawnSync("bash", ["-n", join(REPO_ROOT, SCRIPT)], { encoding: "utf8" });
    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it("refuses a misspelt flag before reading or pushing anything", () => {
    const result = push(["--delete-stail"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown argument: --delete-stail");
    expect(result.stderr).toContain("usage:");
    expect(result.calls).toBe("");
    expect(heldNames()).toEqual(["GCP_DEPLOY_KEY", STALE].sort());
  });

  it("without --delete-stale, reports a stale name, deletes nothing and exits 0", () => {
    const result = push([]);
    expect(result.status, result.stderr).toBe(0);
    expect(reported(result.stderr)).toEqual([STALE]);
    expect(result.stderr).toContain("Nothing was deleted");
    expect(result.calls).not.toContain("secret delete");
    expect(heldNames()).toContain(STALE);
  });

  it("with --delete-stale, deletes it from the production environment", () => {
    const result = push(["--delete-stale"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain(deleteCall(STALE));
    expect(result.stderr).toContain(`deleted ${STALE}`);
    expect(heldNames()).not.toContain(STALE);
  });

  it("never deletes, or reports, a name the workflow reads", () => {
    const result = push(["--delete-stale"]);
    expect(result.status, result.stderr).toBe(0);
    expect(reported(result.stderr)).toEqual([STALE]);
    for (const name of READ) {
      expect(result.calls, `${name} was deleted`).not.toContain(`secret delete ${name}`);
      expect(result.stderr).not.toContain(`deleted ${name}`);
    }
    // Pushed and still held: the whole list, and the stale name gone.
    expect(heldNames()).toEqual([...READ].sort());
    expect(result.calls.match(/secret delete/g)).toHaveLength(1);
  });

  it("says nothing about stale names when there are none", () => {
    writeFileSync(held, "");
    const result = push(["--delete-stale"]);
    expect(result.status, result.stderr).toBe(0);
    expect(reported(result.stderr)).toEqual([]);
    expect(result.stderr).not.toContain("not read by");
    expect(result.calls).not.toContain("secret delete");
    expect(heldNames()).toEqual([...READ].sort());
  });

  it("fails when GitHub still lists a name it was told to delete", () => {
    const result = push(["--delete-stale"], { STUB_DELETE_NOOP: "1" });
    expect(result.status).toBe(1);
    expect(result.calls).toContain(deleteCall(STALE));
    expect(result.stderr).toContain("Deleted, but GitHub still lists");
  });

  it("keeps values off argv while doing it", () => {
    const result = push(["--delete-stale"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain(`gh secret set GCP_DEPLOY_KEY --repo ${REPO} --env production`);
    for (const value of Object.values(VALUES)) {
      expect(result.calls).not.toContain(value);
    }
  });
});
