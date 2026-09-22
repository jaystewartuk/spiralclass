import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./_tree";

/**
 * `infra/oracle-box/stack/verify-runtime-env.sh` is the only thing that notices
 * an app container booted without its `__LOCAL__` values. The entrypoint
 * refuses to export the placeholder, so the app starts cleanly and quietly
 * loses sign-in, checkout and whatever else the missing values switch on.
 * `scripts/oracle-deploy.sh` fails the deploy on this script's answer.
 *
 * It could never answer yes. It spliced the key list, one name per line, into
 * the program it hands `docker exec … sh -c`, so the loop read
 *
 *     for k in SENTRY_DSN
 *     POSTHOG_KEY; do
 *
 * which every POSIX shell rejects as a syntax error once there is a second
 * name. Its `2>/dev/null` then turned the syntax error into "UNREACHABLE:
 * (running?)", so every deploy would have failed as if the container were down.
 * Nobody saw it, because the script only runs on the box, during a deploy.
 *
 * So these run the real script, against a `docker` that executes the command
 * locally in a directory laid out like the image, with the container's
 * environment and nothing else.
 */

const SCRIPT = join(REPO_ROOT, "infra", "oracle-box", "stack", "verify-runtime-env.sh");

// The box runs this under /bin/sh, and the app image's /bin/sh is dash. Use
// dash where it exists, as it does on the Linux runner. The splice above fails
// under bash's sh too, so the test holds on a laptop without dash.
const SH = existsSync("/bin/dash") ? "/bin/dash" : "sh";

const FAKE_DOCKER = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const [verb, ...rest] = process.argv.slice(2);
const containers = JSON.parse(process.env.FAKE_CONTAINERS);
if (verb === "inspect") process.exit(rest[0] in containers ? 0 : 1);
if (verb !== "exec") { console.error("fake docker: unexpected " + verb); process.exit(64); }
const extra = {};
while (rest[0] === "-e") { const [k, ...v] = rest[1].split("="); extra[k] = v.join("="); rest.splice(0, 2); }
const [name, cmd, ...args] = rest;
if (!(name in containers)) { console.error("fake docker: no container " + name); process.exit(1); }
const run = spawnSync(cmd === "sh" ? process.env.FAKE_SH : cmd, args, {
  cwd: process.env.FAKE_IMAGE_ROOT,
  env: { PATH: process.env.PATH, ...containers[name], ...extra },
  stdio: "inherit",
});
process.exit(run.status ?? 1);
`;

const RUNTIME_ENV = [
  "# comments and plain values are not checked",
  "PLAIN_VALUE=https://example.test",
  "FIRST_KEY=__LOCAL__",
  "SECOND_KEY=__LOCAL__",
  "THIRD_KEY=__LOCAL__",
  "",
].join("\n");

function verify(containerEnv: Record<string, string>, container = "app") {
  const root = mkdtempSync(join(tmpdir(), "verify-runtime-env-"));
  const bin = join(root, "bin");
  const image = join(root, "image");
  mkdirSync(bin);
  mkdirSync(join(image, "config", "env"), { recursive: true });
  writeFileSync(join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(join(image, "config", "env", "preview.runtime.env"), RUNTIME_ENV);

  const run = spawnSync(SH, [SCRIPT, container], {
    encoding: "utf8",
    // The container's own environment is only what FAKE_CONTAINERS says; the
    // fake docker builds it from nothing, so inheriting this one leaks nothing in.
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_SH: SH,
      FAKE_IMAGE_ROOT: image,
      FAKE_CONTAINERS: JSON.stringify({ app: containerEnv }),
    },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe("verify-runtime-env.sh", () => {
  it("passes when every __LOCAL__ value is supplied, with more than one of them", () => {
    const run = verify({
      APP_ENV: "preview",
      FIRST_KEY: "a",
      SECOND_KEY: "b",
      THIRD_KEY: "c",
    });
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("OK: app — all 3 present");
    expect(run.status).toBe(0);
  });

  it("names every value that is unset or still the placeholder, and fails", () => {
    const run = verify({ APP_ENV: "preview", FIRST_KEY: "a", THIRD_KEY: "__LOCAL__" });
    expect(run.stderr).toContain("FAIL: app — missing: SECOND_KEY THIRD_KEY");
    expect(run.status).toBe(1);
  });

  it("fails when APP_ENV points at no config file, rather than checking nothing", () => {
    const run = verify({ APP_ENV: "staging", FIRST_KEY: "a", SECOND_KEY: "b", THIRD_KEY: "c" });
    expect(run.stderr).toContain("could not read config/env/$APP_ENV.runtime.env");
    expect(run.status).toBe(1);
  });

  it("fails on a container that does not exist", () => {
    const run = verify({ APP_ENV: "preview" }, "gone");
    expect(run.stderr).toContain("MISSING CONTAINER: gone");
    expect(run.status).toBe(1);
  });
});
