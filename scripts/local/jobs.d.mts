// Types for the hand-run maintenance registry (scripts/local/jobs.mjs). Kept as
// a sibling declaration for the same reason as scripts/ci/steps.d.mts: the
// module stays a plain runnable .mjs — `node scripts/local/run.mjs backup` must
// work with no build step — while the guard test
// (apps/web/tests/config/local-gate.test.ts) imports it with full types.

export interface Job {
  /** CLI handle and receipt key. */
  id: string;
  title: string;
  /** argv, run from the repo root. */
  cmd: string[];
  /** Hours since the last SUCCESS before `pnpm gate` warns about it. */
  staleAfterHours: number;
  /** ntfy priority when a run fails. */
  urgency: "urgent" | "high" | "default";
  /** One line, printed by `pnpm local:status`. */
  why: string;
}

export const JOBS: Job[];
export const JOB_IDS: string[];

export function jobById(id: string): Job | undefined;
