import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { REPO_ROOT } from "./_tree";

/**
 * `infra/infisical/push-vercel-env.sh` is how the Vercel failover gets the
 * runtime secrets Fly gets ([D-177]). Its whole job is choosing WHICH values,
 * and every wrong choice is silent: reading `/` recursively would put the
 * deploy's own Fly and Neon credentials inside the failover's running app, and
 * a preview bucket's credentials would point production storage at preview.
 *
 * The script is operator-only and talks to Infisical, Tofu and Vercel, so it
 * runs here against stubs: a copy of the three `infra/infisical` files in a
 * scratch tree, with `infisical`, `tofu` and `node` replaced by scripts that log
 * every call. The stub `node` stands where scripts/vercel-env.mjs would run and
 * records what it was handed; that module has its own tests against an
 * in-memory Vercel (apps/web/tests/scripts/vercel-env.test.ts).
 */

const SCRIPT = join("infra", "infisical", "push-vercel-env.sh");

/** What Infisical holds, by path. `/deploy` holds the Fly token too — which must not travel. */
const ROOT = [
  { key: "STRIPE_SECRET_KEY", value: "stub-stripe-value" },
  { key: "DATABASE_URL", value: "postgresql://stub-database-value" },
];
const CONFIG = [{ key: "NEXT_PUBLIC_SENTRY_DSN", value: "stub-config-value" }];
const DEPLOY: Record<string, string> = {
  VERCEL_TOKEN: "stub-vercel-token",
  VERCEL_ORG_ID: "team_stub",
  VERCEL_PROJECT_ID: "prj_stub",
  FLY_API_TOKEN: "stub-fly-token",
};
const BUCKETS = {
  "agendaprofe-production-chat-audio": {
    bucket: "agendaprofe-production-chat-audio",
    endpoint: "https://stub.r2.cloudflarestorage.com",
    region: "auto",
    access_key_id: "stub-r2-key",
    secret_access_key: "stub-r2-secret",
    env_prefix: "CHAT_AUDIO_R2",
    environment: "production",
  },
};

const scratch = mkdtempSync(join(tmpdir(), "push-vercel-env-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const tree = join(scratch, "repo");
const bin = join(scratch, "bin");
const log = join(scratch, "calls.log");
const handed = join(scratch, "handed.json");
const handedEnv = join(scratch, "handed-env.txt");

mkdirSync(join(tree, "infra", "infisical"), { recursive: true });
mkdirSync(join(tree, "infra", "cloudflare-r2"), { recursive: true });
mkdirSync(join(tree, "scripts"), { recursive: true });
mkdirSync(bin, { recursive: true });

for (const file of ["push-vercel-env.sh", "infisical.sh", "project-id.sh"]) {
  copyFileSync(join(REPO_ROOT, "infra", "infisical", file), join(tree, "infra", "infisical", file));
}

const stub = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};

// `export --path=<p>` prints that path's JSON; `secrets get KEY … --path <p>`
// prints KEY=value from that path, as the real CLI's dotenv output does.
stub(
  "infisical",
  `case "$1" in
  export)
    for arg in "$@"; do
      case "$arg" in
        --path=/) echo '${JSON.stringify(ROOT)}'; exit 0 ;;
        --path=/config) echo '${JSON.stringify(CONFIG)}'; exit 0 ;;
      esac
    done
    echo '[]' ;;
  secrets)
    key="$3"
    case "$*" in
      *"--path /deploy"*) ;;
      *) echo "stub infisical: $key read outside /deploy" >&2; exit 96 ;;
    esac
    case "$key" in
${Object.entries(DEPLOY)
  .map(([k, v]) => `      ${k}) echo "${k}=${v}" ;;`)
  .join("\n")}
      *) exit 1 ;;
    esac ;;
  *) echo "stub infisical: unexpected call: $*" >&2; exit 97 ;;
esac`,
);

// `output -json buckets`, from the directory it ran in — unless STUB_TOFU_FAIL.
stub(
  "tofu",
  `echo "tofu cwd $(pwd)" >> "$STUB_LOG"
[ -n "$STUB_TOFU_FAIL" ] && { echo "stub tofu: no state" >&2; exit 1; }
[ "$*" = "output -json buckets" ] || { echo "stub tofu: unexpected: $*" >&2; exit 97; }
echo '${JSON.stringify(BUCKETS)}'`,
);

// Where scripts/vercel-env.mjs would run: record stdin and the credentials.
stub(
  "node",
  `cat > "$STUB_HANDED"
printf 'VERCEL_TOKEN=%s\\nVERCEL_ORG_ID=%s\\nVERCEL_PROJECT_ID=%s\\n' "$VERCEL_TOKEN" "$VERCEL_ORG_ID" "$VERCEL_PROJECT_ID" > "$STUB_HANDED_ENV"`,
);

const run = (args: string[], extra: Record<string, string> = {}) => {
  writeFileSync(log, "");
  rmSync(handed, { force: true });
  rmSync(handedEnv, { force: true });
  const result = spawnSync("bash", [join(tree, SCRIPT), ...args], {
    cwd: scratch,
    encoding: "utf8",
    env: {
      HOME: scratch,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      STUB_LOG: log,
      STUB_HANDED: handed,
      STUB_HANDED_ENV: handedEnv,
      INFISICAL_PROJECT_ID: "stub-project",
      INFISICAL_SKIP_PROJECT_CHECK: "1",
      ...extra,
    } as unknown as NodeJS.ProcessEnv,
  });
  return { ...result, calls: readFileSync(log, "utf8") };
};

describe("push-vercel-env.sh hands the failover what Fly gets, and nothing else", () => {
  beforeEach(() => writeFileSync(log, ""));

  it("parses, is executable, and uses nothing newer than bash 3.2", () => {
    const path = join(REPO_ROOT, SCRIPT);
    const parsed = spawnSync("bash", ["-n", path], { encoding: "utf8" });
    expect(parsed.status, parsed.stderr).toBe(0);
    expect(statSync(path).mode & 0o111, `${SCRIPT} is not executable`).toBeGreaterThan(0);
    const executable = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    for (const builtin of ["mapfile", "readarray", "declare -A"]) {
      expect(executable).not.toContain(builtin);
    }
  });

  it("refuses a misspelt flag before reading anything", () => {
    const result = run(["--delete-stail"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown argument: --delete-stail");
    expect(result.calls).toBe("");
  });

  it("reads Infisical `/` once, not recursively, and never `/config`", () => {
    const result = run([]);
    expect(result.status, result.stderr).toBe(0);
    const exports = result.calls.split("\n").filter((line) => line.startsWith("infisical export"));
    expect(exports).toHaveLength(1);
    expect(exports[0]).toContain("--path=/ ");
    expect(exports[0]).toContain("--env=production");
    expect(result.calls).not.toContain("--recursive");
    expect(result.calls).not.toContain("/config");
  });

  it("reads exactly the three Vercel credentials from `/deploy`, and no other deploy value", () => {
    const result = run([]);
    expect(result.status, result.stderr).toBe(0);
    const gets = result.calls
      .split("\n")
      .filter((line) => line.startsWith("infisical secrets get"))
      .map((line) => line.split(" ")[3]);
    expect(gets.sort()).toEqual(["VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "VERCEL_TOKEN"]);
    expect(readFileSync(handedEnv, "utf8")).toBe(
      "VERCEL_TOKEN=stub-vercel-token\nVERCEL_ORG_ID=team_stub\nVERCEL_PROJECT_ID=prj_stub\n",
    );
  });

  it("reads the buckets from infra/cloudflare-r2's state", () => {
    const result = run([]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("tofu output -json buckets");
    expect(result.calls).toContain(`tofu cwd ${join(tree, "infra", "cloudflare-r2")}`);
  });

  it("hands the module both sources on stdin, and the deploy's own values in neither", () => {
    const result = run([]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("node scripts/vercel-env.mjs push\n");

    const payload = JSON.parse(readFileSync(handed, "utf8"));
    expect(payload).toEqual({ infisical: ROOT, r2: BUCKETS });
    const text = JSON.stringify(payload);
    expect(text).not.toContain(DEPLOY.FLY_API_TOKEN);
    expect(text).not.toContain(DEPLOY.VERCEL_TOKEN);
    expect(text).not.toContain(CONFIG[0].value);
  });

  it("forwards --delete-stale", () => {
    const result = run(["--delete-stale"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("node scripts/vercel-env.mjs push --delete-stale");
  });

  it("stops, pushing nothing, when the Tofu state cannot be read", () => {
    const result = run([], { STUB_TOFU_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("under the `infra` credentials");
    expect(result.calls).not.toContain("node ");
    expect(existsSync(handed)).toBe(false);
  });

  it("keeps every value off every command line", () => {
    const result = run(["--delete-stale"]);
    expect(result.status, result.stderr).toBe(0);
    const values = [
      ...ROOT.map((e) => e.value),
      ...Object.values(DEPLOY),
      BUCKETS["agendaprofe-production-chat-audio"].access_key_id,
      BUCKETS["agendaprofe-production-chat-audio"].secret_access_key,
    ];
    for (const value of values) {
      expect(result.calls, `${value} reached a command line`).not.toContain(value);
    }
  });
});
