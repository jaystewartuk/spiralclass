import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// The non-secret config tooling lives at the repo root (scripts/), not under
// apps/web — these files feed Fly and local dev alike (D-85).
import {
  ENVIRONMENTS,
  ENV_DIR,
  KINDS,
  REPO_ROOT,
  envFilePath,
  parseEnvFile,
} from "../../../../scripts/env-config.mjs";

const FLY_CONFIGS = {
  preview: resolve(REPO_ROOT, "fly.preview.toml"),
  production: resolve(REPO_ROOT, "fly.production.toml"),
} as const;

// Keys the fly configs are still allowed to declare in [env] — the three the
// platform owns. Everything else moved to config/env/ (D-85).
const ALLOWED_FLY_ENV_KEYS = new Set(["NODE_ENV", "PORT", "APP_ENV"]);

describe("config/env non-secret files", () => {
  it("every env/kind file parses under the strict grammar", () => {
    for (const env of ENVIRONMENTS) {
      for (const kind of KINDS) {
        // parseEnvFile throws on any malformed line (bad key, inline comment,
        // space in value, duplicate) — a passing parse IS the grammar check.
        expect(() => parseEnvFile(envFilePath(env, kind))).not.toThrow();
      }
    }
  });

  it("preserves the deliberately-empty NEXT_PUBLIC_POSTHOG_HOST", () => {
    for (const env of ENVIRONMENTS) {
      const { map } = parseEnvFile(envFilePath(env, "build"));
      // A non-empty host makes the PostHog client bypass the /ingest proxy —
      // the empty value is load-bearing, so it must survive as a present-but-
      // empty key, not vanish (project_preview_posthog_server_key).
      expect(map).toHaveProperty("NEXT_PUBLIC_POSTHOG_HOST");
      expect(map.NEXT_PUBLIC_POSTHOG_HOST).toBe("");
    }
  });

  it("keeps server-side and NEXT_PUBLIC_ twins in sync", () => {
    // These pairs are documented as intentionally-identical (same Sentry
    // project / PostHog client key across server and client SDKs). Guard the
    // invariant so a one-sided edit is caught.
    for (const env of ENVIRONMENTS) {
      const build = parseEnvFile(envFilePath(env, "build")).map;
      const runtime = parseEnvFile(envFilePath(env, "runtime")).map;
      expect(runtime.SENTRY_DSN).toBe(build.NEXT_PUBLIC_SENTRY_DSN);
      expect(runtime.POSTHOG_KEY).toBe(build.NEXT_PUBLIC_POSTHOG_KEY);
    }
  });
});

describe("fly.<env>.toml drift guard (D-85)", () => {
  for (const [env, path] of Object.entries(FLY_CONFIGS)) {
    it(`${env}: [env] only declares platform-owned keys and has no [build.args]`, () => {
      const text = readFileSync(path, "utf8");

      // The moved build-args TOML table must be gone entirely — build-time
      // config is config/env/<env>.build.env now. Match a real table header
      // (line-anchored), not the substring, so the pointer comment that names
      // the old table in prose doesn't trip this.
      expect(text).not.toMatch(/^[ \t]*\[build\.args\]/m);

      // Collect UPPER_SNAKE assignments (env-style keys) anywhere in the file.
      // Only the three platform-owned keys may remain; anything else drifted
      // back in instead of living in config/env/<env>.runtime.env.
      const declared = [...text.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]);
      for (const key of declared) {
        expect(ALLOWED_FLY_ENV_KEYS.has(key), `${env}: unexpected key ${key} in fly config`).toBe(
          true,
        );
      }

      // APP_ENV must be present and match the file's environment, so the
      // entrypoint sources the right config/env/<env>.runtime.env.
      expect(text).toMatch(new RegExp(`APP_ENV\\s*=\\s*'${env}'`));
    });
  }
});

describe("Dockerfile build-arg parity", () => {
  const dockerfile = readFileSync(resolve(REPO_ROOT, "Dockerfile"), "utf8");
  const declaredArgs = new Set(
    [...dockerfile.matchAll(/^ARG\s+(NEXT_PUBLIC_[A-Z0-9_]+)/gm)].map((m) => m[1]),
  );

  for (const env of ENVIRONMENTS) {
    it(`${env}.build.env keys are all declared as ARG in the Dockerfile`, () => {
      const { entries } = parseEnvFile(envFilePath(env, "build"));
      for (const { key } of entries) {
        // A build var the Dockerfile doesn't declare as ARG would be silently
        // dropped from the client bundle — catch it here, not in prod JS.
        expect(declaredArgs.has(key), `Dockerfile missing ARG ${key}`).toBe(true);
      }
    });
  }
});

describe("NEXT_DEPLOYMENT_ID reaches the build", () => {
  // next.config.ts reads NEXT_DEPLOYMENT_ID to set Next's `deploymentId`, which
  // stamps `?dpl=<id>` on asset/chunk/server-action requests so a client left on
  // an old build gets a hard navigation instead of a 404 on a renamed chunk.
  //
  // For a long time next.config.ts read it and NOTHING SET IT — not the
  // Dockerfile, not fly-deploy.sh, not config/env/<env>.build.env — so
  // `deploymentId` was undefined on every image shipped and the mitigation did
  // nothing, with no failure anywhere to say so. Half of AGENDAPROFE-3B reaching
  // a real visitor. These pin the wiring end to end, because the failure mode is
  // silence: it cannot be caught by a build, a type, or a green deploy.
  const dockerfile = readFileSync(resolve(REPO_ROOT, "Dockerfile"), "utf8");
  const flyDeploy = readFileSync(resolve(REPO_ROOT, "scripts", "fly-deploy.sh"), "utf8");

  it("next.config.ts still reads it (the reason the rest of this exists)", () => {
    const nextConfig = readFileSync(resolve(REPO_ROOT, "apps", "web", "next.config.ts"), "utf8");
    expect(nextConfig).toContain("process.env.NEXT_DEPLOYMENT_ID");
    expect(nextConfig).toMatch(/^\s*deploymentId,$/m);
  });

  it("the Dockerfile declares it in BOTH stages", () => {
    // ARG does not cross stages: the builder needs it to bake the id into the
    // output, and the runner needs it so the server validates `?dpl=` against
    // the same value. One without the other is worse than neither.
    const args = [...dockerfile.matchAll(/^ARG\s+NEXT_DEPLOYMENT_ID\s*$/gm)];
    expect(args.length, "expected ARG NEXT_DEPLOYMENT_ID in the builder and runner stages").toBe(2);
    const envs = [...dockerfile.matchAll(/^ENV NEXT_DEPLOYMENT_ID=\$\{NEXT_DEPLOYMENT_ID\}$/gm)];
    expect(envs.length).toBe(2);
  });

  it("fly-deploy.sh passes the deployed commit as the id", () => {
    expect(flyDeploy).toContain('BUILD_ARG_FLAGS+=(--build-arg "NEXT_DEPLOYMENT_ID=${SHA}")');
    // $SHA must be assigned before the array is extended, or the id is empty
    // and every deploy silently ships the pre-fix behaviour again.
    expect(flyDeploy.indexOf('SHA="$(git rev-parse HEAD)"')).toBeGreaterThan(-1);
    expect(flyDeploy.indexOf('SHA="$(git rev-parse HEAD)"')).toBeLessThan(
      flyDeploy.indexOf("BUILD_ARG_FLAGS+=(--build-arg"),
    );
  });

  it("both buildx invocations receive it, byte-identically", () => {
    // The push build must stay a pure cache hit of the first (the registry-token
    // race documented in fly-deploy.sh), which it only is if both are passed the
    // same args. Extending the shared array is what guarantees that — passing
    // --build-arg to one `docker buildx build` and not the other would not.
    //
    // Anchored to the start of a line so the prose above those invocations,
    // which names the command, is not counted as a third one.
    const invocations = [...flyDeploy.matchAll(/^docker buildx build/gm)];
    expect(invocations.length).toBe(2);
    const forwarded = [...flyDeploy.matchAll(/^\s+"\$\{BUILD_ARG_FLAGS\[@\]\}"/gm)];
    expect(forwarded.length, "each buildx invocation must forward the shared array").toBe(2);
  });
});

describe("scripts/env-build-args.mjs", () => {
  /**
   * A stand-in for every value the committed file marks `__LOCAL__`.
   *
   * ⚠️ Those values name the operator's own accounts, so they live in a
   * gitignored overlay — and a gitignored file exists in exactly ONE checkout.
   * Resolving through the overlay made this test pass in the main clone and
   * fail in every git worktree and on every CI runner, which is the same class
   * of bug as a test that only passes on the machine that wrote it.
   *
   * Supplying them through the process environment is not a workaround; it is
   * the other real path. `resolveEnvFile` reads the environment BEFORE the
   * overlay file precisely so a runner can satisfy the sentinels with no file
   * at all ([D-157]), which is how the deploy workflows do it. So this
   * exercises more of the contract than the overlay did, and does it
   * identically everywhere.
   */
  const STUB = "stub-value";
  const sentinelKeys = () =>
    parseEnvFile(envFilePath("preview", "build"))
      .entries.filter((e) => e.value === "__LOCAL__")
      .map((e) => e.key);

  function run(env: string, extraEnv: Record<string, string> = {}): string {
    return execFileSync("node", ["scripts/env-build-args.mjs", env], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
    });
  }

  it("emits a GITHUB_OUTPUT heredoc block including empty values", () => {
    const stubs = Object.fromEntries(sentinelKeys().map((key) => [key, STUB]));
    const out = run("preview", stubs);
    expect(out).toContain("build_args<<__FLY_BUILD_ARGS_EOF__");
    expect(out).toContain("\n__FLY_BUILD_ARGS_EOF__\n");
    // Empty value line is emitted, not skipped.
    expect(out).toMatch(/^NEXT_PUBLIC_POSTHOG_HOST=$/m);
    // Every key in the committed file reaches the output with its RESOLVED
    // value. Asserting against unresolved sentinels would pass on a machine
    // that cannot build, which is the wrong direction for this to be lenient
    // in.
    const { entries } = parseEnvFile(envFilePath("preview", "build"));
    expect(entries.some((e) => e.value === "__LOCAL__")).toBe(true);
    for (const { key, value } of entries) {
      expect(out).toContain(`${key}=${value === "__LOCAL__" ? STUB : value}`);
    }
    // And no sentinel survives into the build args, whatever the source.
    expect(out).not.toContain("__LOCAL__");
  });

  it("resolves a sentinel from the environment ahead of the overlay file", () => {
    // The precedence the deploy workflows depend on. Every sentinel is
    // supplied so the run can complete anywhere; one carries a distinctive
    // value, and on the one machine that HAS an overlay that value proves the
    // environment wins over the file rather than merely filling a gap.
    const keys = sentinelKeys();
    const env = Object.fromEntries(keys.map((key) => [key, STUB]));
    env[keys[0]] = "from-the-environment";
    expect(run("preview", env)).toContain(`${keys[0]}=from-the-environment`);
  });

  it("rejects an unknown environment", () => {
    expect(() => run("staging")).toThrow();
  });
});

describe("scripts/docker-entrypoint.sh", () => {
  // Exercise the real entrypoint: it sources config/env/$APP_ENV.runtime.env
  // then execs its args. We exec a shell that echoes a var, so stdout is the
  // sourced value.
  function entrypointValue(key: string, env: Record<string, string>): string {
    return execFileSync("sh", ["scripts/docker-entrypoint.sh", "sh", "-c", `printf %s "$${key}"`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  it("sources the runtime file selected by APP_ENV", () => {
    expect(entrypointValue("CSP_ENFORCE", { APP_ENV: "preview" })).toBe("1");
    expect(entrypointValue("APP_URL", { APP_ENV: "production" })).toBe("https://spiralclass.com");
  });

  it("lets container env win over the committed default", () => {
    // A secret / fly-secrets override for the same key must not be clobbered.
    expect(entrypointValue("CSP_ENFORCE", { APP_ENV: "preview", CSP_ENFORCE: "0" })).toBe("0");
  });

  it("fails loudly when APP_ENV names a missing file", () => {
    expect(() =>
      execFileSync("sh", ["scripts/docker-entrypoint.sh", "true"], {
        cwd: REPO_ROOT,
        env: { ...process.env, APP_ENV: "nope" },
      }),
    ).toThrow();
  });
});
