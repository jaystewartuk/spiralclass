// Types for scripts/vercel-await.mjs. A sibling declaration, like
// vercel-env.d.mts, so the module stays a plain runnable .mjs while tests import
// it with full types.

import type { VercelDeployment } from "./vercel-env.mjs";

export const IN_PROGRESS: ReadonlySet<string>;

export const DEFAULT_TIMEOUT_MS: number;

export function deploymentRef(arg: unknown): string | null;

export function verdict(deployment: VercelDeployment | null | undefined): {
  done: boolean;
  ok?: boolean;
  lines: string[];
};

export function awaitDeployment(options: {
  ref: string;
  get: (ref: string) => Promise<VercelDeployment>;
  log: (line: string) => void;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<number>;
