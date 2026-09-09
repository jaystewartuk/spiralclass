#!/usr/bin/env node
// Emit an environment's build-time NEXT_PUBLIC_* config as a GITHUB_OUTPUT
// multiline value, so docker/build-push-action (and scripts/fly-deploy.sh) can
// pass them as --build-arg. Replaces the old scripts/fly-build-args.py, which
// read fly.<env>.toml's [build.args] — that table moved to
// config/env/<env>.build.env (D-85), and this reads the new source of truth.
//
// Why not re-type the values into the workflow: they are per-environment
// (preview and production point at different Supabase projects / R2 buckets)
// and are baked IRREVERSIBLY into the client bundle at build time, so a copy
// that silently drifts ships wrong values to real browsers with nothing
// failing. config/env/<env>.build.env stays the single source of truth.
//
// Usage: node scripts/env-build-args.mjs preview >> "$GITHUB_OUTPUT"

import { ENVIRONMENTS, envFilePath, resolveEnvFile } from "./env-config.mjs";

// Heredoc-style delimiter: build args are multiline by nature (one NAME=VALUE
// per line) and GITHUB_OUTPUT's plain `k=v` form cannot express that. Kept
// byte-for-byte from the Python predecessor so scripts/fly-deploy.sh's sed that
// strips this wrapper keeps working unchanged.
const DELIMITER = "__FLY_BUILD_ARGS_EOF__";

function main() {
  const env = process.argv[2];
  if (!env || !ENVIRONMENTS.includes(env)) {
    process.stderr.write(`usage: ${process.argv[1]} <${ENVIRONMENTS.join("|")}>\n`);
    return 2;
  }

  const path = envFilePath(env, "build");
  // resolveEnvFile, not parseEnvFile: build args are baked IRREVERSIBLY into
  // the client bundle, so a __LOCAL__ placeholder reaching this point would
  // ship a broken Sentry DSN or Stripe key to real browsers with nothing
  // failing. It throws instead, naming every unsatisfied key.
  const { entries } = resolveEnvFile(env, "build");

  for (const { key, value } of entries) {
    // A value containing the delimiter would let the caller inject arbitrary
    // workflow outputs. None of ours do; fail loudly if that ever changes.
    if (value.includes(DELIMITER)) {
      process.stderr.write(`::error::${path}: build arg ${key} contains the output delimiter\n`);
      return 1;
    }
  }

  const lines = [`build_args<<${DELIMITER}`];
  for (const { key, value } of entries) {
    // Empty values are meaningful and must survive: NEXT_PUBLIC_POSTHOG_HOST=''
    // is deliberate (a non-empty host makes the client bypass the /ingest proxy).
    lines.push(`${key}=${value}`);
  }
  lines.push(DELIMITER);
  process.stdout.write(lines.join("\n") + "\n");

  process.stderr.write(`Collected ${entries.length} build arg(s) from ${path}\n`);
  return 0;
}

process.exit(main());
