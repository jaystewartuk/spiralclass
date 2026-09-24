// Types for scripts/cloudrun-env.mjs. A sibling declaration, like
// env-config.d.mts, so the module stays a plain runnable .mjs while the guard
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

/** Which source a name came from. */
export const SOURCE: { readonly infisical: string; readonly r2: string };

/** Five names per production R2 bucket, as the app reads them. */
export function r2Entries(buckets: unknown): { key: string; value: string }[];

/** The runtime secret set: Infisical `production` at `/` plus the production R2 credentials. */
export function pushedEntries(sources: {
  infisical: { key: string; value: string }[];
  r2: unknown;
}): Map<string, SecretEntry>;

/** Where the running app's code lives; scanned for the names it reads. */
export const APP_SOURCE_DIRS: readonly string[];

/** Families of names the app builds at run time, so no source file spells one out. */
export const RUNTIME_BUILT_PREFIXES: readonly string[];

/** Every upper-snake token in the app's source and apps/web's top-level config. */
export function appSourceNames(repoRoot: string): Promise<Set<string>>;

/** Splits entries into those the app reads and the names of those it never does. */
export function partitionByUse(
  entries: { key: string; value: string }[] | undefined,
  readable: ReadonlySet<string>,
): { kept: { key: string; value: string }[]; omitted: string[] };
