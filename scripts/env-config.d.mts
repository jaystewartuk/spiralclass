// Types for the config/env parser (scripts/env-config.mjs). Kept as a sibling
// declaration so the module stays a plain runnable .mjs (no build step for
// `node scripts/env-build-args.mjs`) while tests import it with full types.

export const REPO_ROOT: string;
export const ENV_DIR: string;
export const ENVIRONMENTS: readonly ["preview", "production"];
export const KINDS: readonly ["build", "runtime"];

/** Absolute path to a config/env file, e.g. envFilePath("preview", "build"). */
export function envFilePath(env: string, kind: string): string;

export interface EnvEntry {
  key: string;
  value: string;
}

export interface ParsedEnvFile {
  entries: EnvEntry[];
  map: Record<string, string>;
}

/** Parse a config/env file; throws on any malformed line. */
export function parseEnvFile(path: string): ParsedEnvFile;

/** The value a committed config file carries when the real one is not in git. */
export const LOCAL_SENTINEL: string;

/** Absolute path to the gitignored overlay supplying an environment's real values. */
export function localEnvFilePath(env: string, kind: string): string;

/**
 * The committed file with its `__LOCAL__` sentinels filled in from the overlay.
 * Throws if any sentinel is unsatisfied, or if the overlay declares a key the
 * committed file does not.
 */
export function resolveEnvFile(env: string, kind: string): ParsedEnvFile;
