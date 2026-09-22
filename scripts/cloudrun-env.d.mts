// Types for scripts/cloudrun-env.mjs. A sibling declaration, like
// vercel-env.d.mts, so the module stays a plain runnable .mjs while the guard
// test (apps/web/tests/config/cloudrun-deploy.test.ts) imports it with types.

/** One name's value and which source owns it, as `pushedEntries` returns them. */
export interface SecretEntry {
  value: string;
  owner: string;
}

/**
 * The env-file text scripts/docker-entrypoint.sh will source, one `KEY=value`
 * per line, sorted by key.
 *
 * @throws if a value contains a newline — the entrypoint reads a line at a time
 *   and does not evaluate the value, so one cannot survive the round trip.
 */
export function composeEnvFile(desired: ReadonlyMap<string, SecretEntry>): string;

/** The names written, sorted — for a report that says what happened, not what it was. */
export function namesOf(desired: ReadonlyMap<string, SecretEntry>): string[];
