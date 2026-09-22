// Parser for the non-secret config files in config/env/ (D-85).
//
// The .env grammar is the strict intersection of what bash (docker-entrypoint.sh
// + dev.sh), this Node module, and the same shell in the Docker image can all
// agree on — see config/env/README.md. Keep this parser in lockstep with the
// shell loop in scripts/docker-entrypoint.sh: `KEY=value`, one per line;
// whole-line `#` comments; blank lines skipped; values unquoted; an empty value
// (`KEY=`) is meaningful and preserved.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/ sits directly under the repo root.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_DIR = resolve(REPO_ROOT, "config", "env");

export const ENVIRONMENTS = ["preview", "production"];
export const KINDS = ["build", "runtime"];

/**
 * The value a committed config file carries when the real one is deliberately
 * NOT in git — an account id, a tenant key, anything that names the operator's own
 * accounts rather than demonstrating how the system is built.
 *
 * ⚠ It must never reach a build or a boot. `resolveEnvFile` throws if one is
 * unsatisfied, `scripts/fly-deploy.sh` preflights for it, and
 * `scripts/docker-entrypoint.sh` refuses to export it — a placeholder that
 * shipped quietly would point production at a project that does not exist,
 * which is strictly worse than the value being in git.
 */
export const LOCAL_SENTINEL = "__LOCAL__";

/** Absolute path to a config/env file, e.g. envFilePath("preview", "build"). */
export function envFilePath(env, kind) {
  return resolve(ENV_DIR, `${env}.${kind}.env`);
}

/**
 * Absolute path to the gitignored overlay that supplies the real values for
 * this environment's sentinels. Same grammar as the committed file; only keys
 * whose committed value is the sentinel are read from it.
 *
 * This is the LAPTOP source. A CI runner has no such file and should not: see
 * `resolveEnvFile`, which reads the process environment first so a workflow can
 * supply the same values from repository secrets.
 */
export function localEnvFilePath(env, kind) {
  return resolve(ENV_DIR, `${env}.${kind}.local.env`);
}

/**
 * The committed file with its sentinels filled in from the local overlay.
 *
 * The committed file stays the source of truth for WHICH keys exist, their
 * order and their documentation; the overlay only supplies values. A key
 * present in the overlay but not in the committed file is an error rather than
 * an addition — otherwise the overlay becomes a second, undocumented config.
 *
 * @param {string} env  "preview" | "production"
 * @param {string} kind "build" | "runtime"
 * @returns {{ entries: {key: string, value: string}[], map: Record<string,string> }}
 */
export function resolveEnvFile(env, kind) {
  const committedPath = envFilePath(env, kind);
  const { entries } = parseEnvFile(committedPath);

  // Two sources, highest precedence first.
  //
  //   1. the process environment — a CI runner injecting repository secrets,
  //      which is how this resolves once deployment moves to GitHub Actions
  //      (free on a public repo, and a NATIVE amd64 build rather than the
  //      20-30 minute QEMU cross-build an arm64 laptop is stuck with);
  //   2. the gitignored overlay file — the operator's machine.
  //
  // Deliberately in that order rather than the reverse: a runner has no
  // overlay file, and on a laptop that has one, an explicitly exported value
  // is a deliberate act — an operator overriding a single key for one build
  // should not have to edit a file to do it.
  const overlayPath = localEnvFilePath(env, kind);
  let overlay = {};
  if (existsSync(overlayPath)) {
    overlay = parseEnvFile(overlayPath).map;
  }
  for (const { key, value } of entries) {
    if (value !== LOCAL_SENTINEL) continue;
    const fromEnv = process.env[key];
    // An empty string is a meaningful value in this grammar (POSTHOG_HOST=),
    // so test for presence rather than truthiness.
    if (fromEnv !== undefined) overlay[key] = fromEnv;
  }

  if (existsSync(overlayPath)) {
    for (const key of Object.keys(parseEnvFile(overlayPath).map)) {
      if (!entries.some((e) => e.key === key)) {
        throw new Error(
          `${overlayPath}: ${key} is not declared in ${committedPath}. ` +
            `The overlay supplies values; it does not add keys.`,
        );
      }
    }
  }

  const resolved = entries.map(({ key, value }) =>
    value === LOCAL_SENTINEL && key in overlay ? { key, value: overlay[key] } : { key, value },
  );

  const missing = resolved.filter((e) => e.value === LOCAL_SENTINEL).map((e) => e.key);
  if (missing.length > 0) {
    throw new Error(
      `${committedPath}: ${missing.length} value(s) still ${LOCAL_SENTINEL}, ` +
        `absent from ${overlayPath}, and absent from the environment: ${missing.join(", ")}. ` +
        `Export them, or create that file with one KEY=value line per name — ` +
        `see config/env/README.md.`,
    );
  }

  const map = {};
  for (const { key, value } of resolved) map[key] = value;
  return { entries: resolved, map };
}

/**
 * Parse a config/env file into an ordered array of { key, value } and a
 * lookup map. Throws on a malformed line so a typo fails the build loudly
 * rather than silently dropping a var.
 */
export function parseEnvFile(path) {
  const text = readFileSync(path, "utf8");
  const entries = [];
  const map = {};
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) {
      throw new Error(`${path}:${i + 1}: no '=' in non-comment line: ${raw}`);
    }
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);

    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(`${path}:${i + 1}: key must be UPPER_SNAKE_CASE: ${key}`);
    }
    // An unquoted '#' mid-value is an inline comment in most .env dialects but
    // not others — banning it keeps all three parsers in agreement.
    if (value.includes("#")) {
      throw new Error(
        `${path}:${i + 1}: value contains '#' (inline comments are not allowed): ${raw}`,
      );
    }
    if (value.includes(" ")) {
      throw new Error(`${path}:${i + 1}: value contains a space (quote-free grammar): ${raw}`);
    }
    if (key in map) {
      throw new Error(`${path}:${i + 1}: duplicate key: ${key}`);
    }

    entries.push({ key, value });
    map[key] = value;
  }

  return { entries, map };
}
