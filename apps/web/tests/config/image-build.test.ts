import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  LOCAL_SENTINEL,
  REPO_ROOT,
  envFilePath,
  parseEnvFile,
} from "../../../../scripts/env-config.mjs";

/**
 * scripts/ci/image-build.sh — the heavy-tier step that builds the production
 * image before a production deploy does (#101).
 *
 * The incident it answers (#100): a Dockerfile that could not build was first
 * built by the production deploy, after the database job had migrated
 * production. So the two properties that matter are that it builds what the
 * deploy builds, and that it can never become a deploy: no push, no registry
 * credential, no image with stub values left behind to be pushed by hand.
 *
 * Most of this runs the REAL script against a fake `docker` on PATH that
 * records its argv, so the assertions are about what would actually be
 * executed rather than about the text of a file.
 */

const SCRIPT_PATH = "scripts/ci/image-build.sh";
const SCRIPT = readFileSync(join(REPO_ROOT, SCRIPT_PATH), "utf8");
const executable = (text: string) =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

const BUILD_ENV = parseEnvFile(envFilePath("production", "build")).entries;
const LOCAL_KEYS = BUILD_ENV.filter((e) => e.value === LOCAL_SENTINEL).map((e) => e.key);

const scratch = mkdtempSync(join(tmpdir(), "spiralclass-image-build-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Records one invocation per block, NUL-free and newline-separated, closed by a
// sentinel line. `buildx build` exits with FAKE_DOCKER_BUILD_EXIT so a failing
// build can be simulated; everything else succeeds.
const FAKE_DOCKER = `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >> "$DOCKER_ARGV_LOG"; done
printf '%s\\n' '--end-of-invocation--' >> "$DOCKER_ARGV_LOG"
if [ "$1" = buildx ] && [ "$2" = build ]; then exit "\${FAKE_DOCKER_BUILD_EXIT:-0}"; fi
exit 0
`;
writeFileSync(join(scratch, "docker"), FAKE_DOCKER);
chmodSync(join(scratch, "docker"), 0o755);

let runs = 0;
function runScript(extraEnv: Record<string, string> = {}) {
  const log = join(scratch, `argv-${runs++}.log`);
  writeFileSync(log, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${scratch}:${process.env.PATH}`,
    DOCKER_ARGV_LOG: log,
    // The machine lock is a separate guarantee (local-gate.test.ts asserts the
    // script takes it); a unit test must not queue behind a real gate.
    SPIRALCLASS_LOCK_INNER: "1",
    ...extraEnv,
  };
  if (!("IMAGE_BUILD_PLATFORM" in extraEnv)) delete env.IMAGE_BUILD_PLATFORM;
  const result = spawnSync("bash", [SCRIPT_PATH], { cwd: REPO_ROOT, env, encoding: "utf8" });
  const invocations = readFileSync(log, "utf8")
    .split("--end-of-invocation--\n")
    .filter(Boolean)
    .map((block) => block.split("\n").filter((_, i, all) => i < all.length - 1));
  const build = invocations.find((argv) => argv[0] === "buildx" && argv[1] === "build");
  return { result, invocations, build };
}

/** Every `--build-arg` value in a build argv, as a KEY → value map. */
function buildArgs(argv: string[]) {
  const args: Record<string, string> = {};
  argv.forEach((arg, i) => {
    if (arg !== "--build-arg") return;
    const pair = argv[i + 1];
    args[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1);
  });
  return args;
}

const flagValue = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe("the image build is the deploy's build, minus the credentials (#101)", () => {
  it("has something to stub, or every assertion below is vacuous", () => {
    expect(LOCAL_KEYS.length).toBeGreaterThan(0);
  });

  it("parses as bash, uses nothing newer than bash 3.2, and is executable", () => {
    const parsed = spawnSync("bash", ["-n", join(REPO_ROOT, SCRIPT_PATH)], { encoding: "utf8" });
    expect(parsed.status, `${SCRIPT_PATH} does not parse:\n${parsed.stderr}`).toBe(0);
    for (const builtin of ["mapfile", "readarray", "declare -A"]) {
      expect(executable(SCRIPT), `${SCRIPT_PATH} uses ${builtin} — bash 4+ only`).not.toContain(
        builtin,
      );
    }
    expect(statSync(join(REPO_ROOT, SCRIPT_PATH)).mode & 0o111).toBeGreaterThan(0);
  });

  it("builds, and passes a stub for every __LOCAL__ key in production.build.env", () => {
    const { result, build } = runScript();
    expect(result.status, `the script failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(build, "the script never ran `docker buildx build`").toBeDefined();

    const args = buildArgs(build!);
    for (const key of LOCAL_KEYS) {
      expect(args[key], `${key} reached the build unstubbed`).toBeDefined();
      expect(args[key]).not.toBe(LOCAL_SENTINEL);
      expect(args[key]).toMatch(/image-build-stub/);
    }
    // The committed, non-secret values pass through as the deploy passes them.
    for (const { key, value } of BUILD_ENV.filter((e) => e.value !== LOCAL_SENTINEL)) {
      expect(args[key], `${key} did not pass through from the committed file`).toBe(value);
    }
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(args.NEXT_DEPLOYMENT_ID).toBe(head.trim());
  });

  it("never lets a real value from the caller's environment into the build", () => {
    // A laptop shell under infra/infisical/run.sh has the real values exported.
    // The step must give the same answer with or without them.
    const real = Object.fromEntries(LOCAL_KEYS.map((key) => [key, `real-${key.toLowerCase()}`]));
    const { result, build } = runScript(real);
    expect(result.status, result.stderr).toBe(0);
    const args = buildArgs(build!);
    for (const key of LOCAL_KEYS) {
      expect(args[key], `${key}'s real value reached the build`).not.toBe(real[key]);
    }
  });

  it("builds linux/amd64 by default, the platform Fly runs, and takes an override", () => {
    const { build } = runScript();
    expect(flagValue(build!, "--platform")).toBe("linux/amd64");
    // The deploy builds the same platform; if that ever moves, this default
    // must move with it.
    expect(readFileSync(join(REPO_ROOT, "scripts", "fly-deploy.sh"), "utf8")).toContain(
      "--platform linux/amd64",
    );

    const native = runScript({ IMAGE_BUILD_PLATFORM: "linux/arm64" });
    expect(flagValue(native.build!, "--platform")).toBe("linux/arm64");
  });

  it("builds the stage the deploy builds — the Dockerfile's last — from the repo root", () => {
    const { build } = runScript();
    expect(build!.at(-1), "the build context is not the repo root").toBe(".");
    expect(build!, "naming a stage stops this being the deploy's build").not.toContain("--target");
    expect(
      executable(readFileSync(join(REPO_ROOT, "scripts", "fly-deploy.sh"), "utf8")),
    ).not.toMatch(/--target/);
  });

  it("resolves the build args through the deploy's resolver, and names no key itself", () => {
    const code = executable(SCRIPT);
    expect(code).toContain('node scripts/env-build-args.mjs "$ENVIRONMENT"');
    expect(code).toMatch(/^ENVIRONMENT=production$/m);
    // Derived from the file, so a key added there is stubbed here in the same
    // commit. A literal key in the script is the list that stops growing.
    for (const key of LOCAL_KEYS) {
      expect(code, `${SCRIPT_PATH} names ${key} literally`).not.toContain(key);
    }
  });

  it("goes red when the build does", () => {
    const { result } = runScript({ FAKE_DOCKER_BUILD_EXIT: "17" });
    expect(result.status).not.toBe(0);
  });
});

describe("the image build can never become a deploy (#101)", () => {
  it("runs only buildx, and never pushes, tags, loads or logs in", () => {
    const { result, invocations, build } = runScript();
    expect(result.status, result.stderr).toBe(0);

    for (const argv of invocations) {
      expect(argv[0], `docker ${argv.join(" ")} is not a buildx call`).toBe("buildx");
      expect(["version", "build"]).toContain(argv[1]);
    }
    // The result is discarded, so no image carrying stub values exists to be
    // pushed by hand afterwards — not even in the local image store.
    expect(flagValue(build!, "--output")).toBe("type=cacheonly");
    for (const forbidden of ["--push", "--load", "-t", "--tag"]) {
      expect(build!, `the image build passes ${forbidden}`).not.toContain(forbidden);
    }
    expect(build!.join(" ")).not.toContain("registry.fly.io");
  });

  it("names no deploy tool and no registry credential anywhere it executes", () => {
    // On the text too, not only on one run's argv: a branch the fake docker
    // never reaches is still a branch that could push.
    const code = executable(SCRIPT);
    for (const forbidden of [
      "--push",
      "flyctl",
      "docker login",
      "docker push",
      "auth docker",
      "registry.fly.io",
      "FLY_API_TOKEN",
      "infisical",
    ]) {
      expect(code, `${SCRIPT_PATH} executes ${forbidden}`).not.toContain(forbidden);
    }
  });
});
