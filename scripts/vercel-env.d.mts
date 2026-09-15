// Types for scripts/vercel-env.mjs. A sibling declaration, like
// env-config.d.mts, so the module stays a plain runnable .mjs while tests import
// it with full types.

import type { EnvEntry } from "./env-config.mjs";

export const ENVIRONMENT: "production";

export const OWNER: {
  readonly infisical: string;
  readonly r2: string;
  readonly committed: string;
};

/** One entry as Vercel's env list returns it. A sensitive entry has no value. */
export interface VercelEnvEntry {
  id: string;
  key: string;
  type: string;
  target?: string | string[];
  comment?: string;
  gitBranch?: string;
  value?: string;
}

export interface Write {
  id?: string;
  key: string;
  value: string;
  comment: string;
}

export interface R2Bucket {
  bucket?: string | null;
  endpoint?: string | null;
  region?: string | null;
  access_key_id?: string | null;
  secret_access_key?: string | null;
  env_prefix: string;
  environment: string;
  [field: string]: unknown;
}

export interface Sources {
  infisical: EnvEntry[];
  r2: Record<string, R2Bucket>;
}

export type Desired = Map<string, { value: string; owner: string }>;

export function r2Entries(buckets: Record<string, R2Bucket>): EnvEntry[];

export function pushedEntries(sources: Sources): Desired;

export function planPush(
  existing: VercelEnvEntry[],
  desired: Desired,
  options?: { deleteStale?: boolean; committed?: EnvEntry[] },
): {
  update: Write[];
  create: Write[];
  replace: VercelEnvEntry[];
  stale: VercelEnvEntry[];
  remove: VercelEnvEntry[];
};

export function missingPushed(existing: VercelEnvEntry[], desired: Desired): string[];

export function planCommitted(
  existing: VercelEnvEntry[],
  committed?: EnvEntry[],
): {
  update: Write[];
  create: Write[];
  remove: VercelEnvEntry[];
  unpushed: string[];
  unowned: string[];
  overridden: string[];
};

export interface VercelClient {
  list(): Promise<VercelEnvEntry[]>;
  create(entries: Write[], type: "sensitive" | "encrypted"): Promise<void>;
  update(entry: Write & { id: string }): Promise<void>;
  remove(entry: { id: string }): Promise<void>;
}

export function vercelClient(options: {
  token: string;
  teamId: string;
  projectId: string;
  fetch?: typeof globalThis.fetch;
}): VercelClient;

export function runPush(options: {
  sources: Sources;
  deleteStale: boolean;
  client: VercelClient;
  log: (line: string) => void;
  committed?: EnvEntry[];
}): Promise<number>;

export function runSyncCommitted(options: {
  client: VercelClient;
  log: (line: string) => void;
  committed?: EnvEntry[];
}): Promise<number>;
