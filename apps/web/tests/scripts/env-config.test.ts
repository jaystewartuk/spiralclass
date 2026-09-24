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
  resolveEnvFile,
} from "../../../../scripts/env-config.mjs";

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

  it("builds no WhatsApp support number, and no environment can supply one (#105)", () => {
    // It held a person's own mobile number, baked into every client bundle.
    // Removing the secret was not enough while the key stayed `__LOCAL__`:
    // anything that injected the old value — a laptop deploy under Infisical,
    // a stale GitHub secret — would build it straight back in. Committed empty,
    // the resolver never reads it from the environment at all.
    const saved = process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP;
    const stubbed: string[] = [];
    try {
      process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP = "5215512345678";
      for (const env of ENVIRONMENTS) {
        const committed = parseEnvFile(envFilePath(env, "build")).map;
        expect(committed.NEXT_PUBLIC_SUPPORT_WHATSAPP, `${env}.build.env`).toBe("");

        // Every other __LOCAL__ key needs a value, or the resolver throws.
        for (const [key, value] of Object.entries(committed)) {
          if (value === "__LOCAL__" && process.env[key] === undefined) {
            process.env[key] = "stub";
            stubbed.push(key);
          }
        }
        expect(resolveEnvFile(env, "build").map.NEXT_PUBLIC_SUPPORT_WHATSAPP, env).toBe("");
      }
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP;
      else process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP = saved;
      for (const key of stubbed) delete process.env[key];
    }

    for (const workflow of ["deploy-production.yml"]) {
      expect(
        readFileSync(resolve(REPO_ROOT, ".github", "workflows", workflow), "utf8"),
        `${workflow} still reads a WhatsApp secret`,
      ).not.toContain("NEXT_PUBLIC_SUPPORT_WHATSAPP");
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

describe("preview holds no LiveKit key pair (D-94's 2026-09-16 addendum)", () => {
  // The only LiveKit server is production's, and preview gets no credentials
  // for it. This sees the committed files. Infisical's preview environment is
  // the other place a pair could come from, and nothing in the tree can read
  // it: infra/oracle-box/CUTOVER.md step 9 carries that half.
  const LIVEKIT_PAIR = /^LIVEKIT_API_(?:KEY|SECRET)$/;
  const pairKeys = (env: (typeof ENVIRONMENTS)[number], kind: (typeof KINDS)[number]) =>
    parseEnvFile(envFilePath(env, kind))
      .entries.map(({ key }) => key)
      .filter((key) => LIVEKIT_PAIR.test(key));

  it("no preview env file declares either half of the pair", () => {
    for (const kind of KINDS) {
      expect(pairKeys("preview", kind), `preview.${kind}.env`).toEqual([]);
    }
  });

  it("still recognises the pair where it belongs, so the check above checks something", () => {
    // A renamed key, or a parser that stopped returning entries, would pass
    // the preview assertion vacuously. Production's key id is declared, and
    // its secret never is, since it stays in Infisical.
    expect(pairKeys("production", "runtime")).toEqual(["LIVEKIT_API_KEY"]);
  });

  it("the LiveKit activity probes read production's pair, never preview's", () => {
    const code = (path: string) =>
      readFileSync(resolve(REPO_ROOT, path), "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");

    const helper = code("docs/deployment/livekit-credentials.sh");
    expect(helper).toContain("config/env/production.runtime.env");
    expect(helper).toContain("infisical_secrets --path=/config --plain production LIVEKIT_API_KEY");
    expect(helper).toContain("infisical_export_secrets --env production LIVEKIT_API_SECRET");
    // infisical_export_secrets defaults to preview, so a call without an
    // explicit production scope is a call to preview's.
    expect(helper).not.toMatch(/infisical_export_secrets(?! --env production )/);

    for (const probe of [
      "docs/deployment/livekit-activity.sh",
      "docs/deployment/livekit-activity-ink.sh",
    ]) {
      const source = code(probe);
      expect(source, probe).toContain('source "$REPO_ROOT/docs/deployment/livekit-credentials.sh"');
      expect(source, probe).not.toMatch(/infisical_|preview/);
    }
    expect(helper).not.toMatch(/preview/);
  });
});

describe("the platform sets only what it owns (D-85)", () => {
  // Fly's [env] table was held to the platform-owned keys, so config could not
  // drift back out of config/env/. Cloud Run's equivalent is the one
  // --update-env-vars the deploy passes: APP_ENV chooses the runtime file and
  // SECRETS_ENV_FILE names the mounted secret. Anything else set there is a
  // value config/env/<env>.runtime.env no longer owns.
  it("the Cloud Run deploy sets exactly APP_ENV and SECRETS_ENV_FILE", () => {
    const deploy = readFileSync(resolve(REPO_ROOT, "scripts", "cloudrun-deploy.sh"), "utf8");
    const flags = [...deploy.matchAll(/^\s*--update-env-vars "([^"]+)"/gm)].map((m) => m[1]);
    expect(flags).toHaveLength(1);
    const keys = flags[0]
      .split(",")
      .map((pair) => pair.split("=")[0])
      .sort();
    expect(keys).toEqual(["APP_ENV", "SECRETS_ENV_FILE"]);
  });
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
  // Dockerfile, not the deploy script, not config/env/<env>.build.env — so
  // `deploymentId` was undefined on every image shipped and the mitigation did
  // nothing, with no failure anywhere to say so. Half of AGENDAPROFE-3B reaching
  // a real visitor. These pin the wiring end to end, because the failure mode is
  // silence: it cannot be caught by a build, a type, or a green deploy.
  const dockerfile = readFileSync(resolve(REPO_ROOT, "Dockerfile"), "utf8");
  const cloudrunDeploy = readFileSync(resolve(REPO_ROOT, "scripts", "cloudrun-deploy.sh"), "utf8");

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

  it("the Cloud Run deploy passes the full deployed commit as the id", () => {
    expect(cloudrunDeploy).toContain('BUILD_ARGS+=(--build-arg "NEXT_DEPLOYMENT_ID=$SHA")');
    // $SHA must be assigned before the array is extended, or the id is empty
    // and every deploy silently ships the pre-fix behaviour again.
    expect(cloudrunDeploy.indexOf('SHA="$(git rev-parse HEAD)"')).toBeGreaterThan(-1);
    expect(cloudrunDeploy.indexOf('SHA="$(git rev-parse HEAD)"')).toBeLessThan(
      cloudrunDeploy.indexOf("NEXT_DEPLOYMENT_ID=$SHA"),
    );
  });

  it("stamps the full commit, never the short one", () => {
    // Cloud Run shipped the SHORT sha until 2026-09-23. The full one is what
    // `git log origin/production` and the image tag name, so the id a skewed
    // client reports can be matched to a release without a lookup.
    expect(cloudrunDeploy).not.toMatch(/NEXT_DEPLOYMENT_ID=\$\{?SHORT_SHA/);
  });

  it("the build forwards it through the shared array", () => {
    const build = cloudrunDeploy.slice(cloudrunDeploy.indexOf("\ndocker buildx build"));
    // The empty-safe form shell-empty-arrays.test.ts requires of an array
    // initialised `BUILD_ARGS=()`.
    expect(build).toMatch(/^\s+\$\{BUILD_ARGS\[@\]\+"\$\{BUILD_ARGS\[@\]\}"\} \\$/m);
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
