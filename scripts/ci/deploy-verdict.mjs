/**
 * What a production deploy run says about production, read job by job
 * ([D-177]'s addendum).
 *
 * .github/workflows/deploy-production.yml runs three jobs: `database`, then
 * `fly` and `vercel` side by side. A RUN is red whenever any one of its jobs
 * is, so `gh run watch --exit-status` could not tell "production did not ship"
 * from "the failover did not refresh" — a Vercel secret not yet synced made
 * `pnpm promote` report that the running app might not have moved, while Fly
 * had shipped and been probed.
 *
 * Production is serving the commit exactly when the database job and the Fly
 * job are both green. The Vercel job is reported beside that verdict and never
 * decides it.
 *
 * Pure, so a table test can hold it without a run to watch.
 */

/**
 * Each job's `name:`, exactly as deploy-production.yml declares it — `gh run
 * view --json jobs` reports jobs by that name, not by their key.
 * apps/web/tests/config/production-targets.test.ts asserts every one of these
 * is a job name in that file, so a rename there fails a test rather than
 * turning every future promote red.
 */
export const DEPLOY_JOBS = Object.freeze({
  database: "Checkpoint and migrate the production database",
  fly: "Build amd64, deploy to Fly and probe production",
  vercel: "Deploy the same commit to the Vercel failover, without taking the domain",
});

/**
 * @param {ReadonlyArray<{ name?: string; conclusion?: string | null; status?: string }>} jobs
 *   `.jobs` from `gh run view <id> --json jobs`.
 * @returns {{ productionOk: boolean; database: string; fly: string; vercel: string }}
 *   Each target's conclusion (`success`, `failure`, `skipped`, …), or `missing`
 *   when the run has no job by that name.
 */
export function deployVerdict(jobs) {
  const outcome = (name) => {
    const job = jobs.find((candidate) => candidate.name === name);
    if (!job) return "missing";
    // An in-progress job has an empty conclusion. It is not green, and saying
    // what it is doing beats reporting nothing.
    return job.conclusion || job.status || "unknown";
  };

  const database = outcome(DEPLOY_JOBS.database);
  const fly = outcome(DEPLOY_JOBS.fly);
  const vercel = outcome(DEPLOY_JOBS.vercel);

  return { productionOk: database === "success" && fly === "success", database, fly, vercel };
}

/**
 * One line about the failover, for the end of a promote.
 *
 * @param {string} vercel the Vercel job's outcome from {@link deployVerdict}
 */
export function failoverLine(vercel) {
  if (vercel === "success") return "  Vercel failover: refreshed, and holding no domain.";
  if (vercel === "skipped") {
    return "  Vercel failover: skipped — it waits on the database job, never on Fly.";
  }
  return `  ⚠ Vercel failover: ${vercel}, so it did not refresh. That does not change whether production shipped.`;
}
