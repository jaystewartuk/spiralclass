/**
 * What a production deploy run says about production, read job by job
 * ([D-177]'s addendum).
 *
 * .github/workflows/deploy-production.yml runs `database`, then `cloudrun`.
 * Production is serving the commit exactly when both are green. The run's own
 * exit status would say the same thing today, with one target; it did not
 * while a Vercel failover ran beside them, and reading the jobs by name keeps
 * the verdict about the thing serving the domain however many targets the
 * workflow grows ([D-186]).
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
  cloudrun: "Build amd64, deploy to Cloud Run and probe production",
});

/**
 * @param {ReadonlyArray<{ name?: string; conclusion?: string | null; status?: string }>} jobs
 *   `.jobs` from `gh run view <id> --json jobs`.
 * @returns {{ productionOk: boolean; database: string; cloudrun: string }}
 *   Each job's conclusion (`success`, `failure`, `skipped`, …), or `missing`
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
  const cloudrun = outcome(DEPLOY_JOBS.cloudrun);

  return {
    productionOk: database === "success" && cloudrun === "success",
    database,
    cloudrun,
  };
}
