// Types for the production deploy verdict (scripts/ci/deploy-verdict.mjs).
// Sibling declaration for the same reason relevance.d.mts is one: the module
// stays a plain runnable .mjs with no build step, while the guard test
// (apps/web/tests/config/production-targets.test.ts) imports it with full types.

/** Each deploy job's `name:`, exactly as deploy-production.yml declares it. */
export const DEPLOY_JOBS: Readonly<{
  database: string;
  cloudrun: string;
  vercel: string;
}>;

/** The targets that are deployed but serve no domain — reported, never decisive. */
export const STANDBYS: Readonly<{
  vercel: string;
}>;

/** One entry of `gh run view <id> --json jobs`'s `.jobs`. */
export interface RunJob {
  name?: string;
  conclusion?: string | null;
  status?: string;
}

export interface DeployVerdict {
  /** The database job and the Cloud Run job — the one serving the domain — are both green. */
  productionOk: boolean;
  /** Each job's conclusion or status, or `missing` when the run has no such job. */
  database: string;
  cloudrun: string;
  vercel: string;
}

export function deployVerdict(jobs: ReadonlyArray<RunJob>): DeployVerdict;

/** One line per standby, newline-joined, for the end of a promote. */
export function failoverLine(verdict: { vercel: string }): string;
