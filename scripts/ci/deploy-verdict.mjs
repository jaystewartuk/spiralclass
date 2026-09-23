/**
 * What a production deploy run says about production, read job by job
 * ([D-177]'s addendum).
 *
 * .github/workflows/deploy-production.yml runs three jobs: `database`, then
 * `cloudrun` and `vercel` side by side. A RUN is red whenever any one of its
 * jobs is, so `gh run watch --exit-status` could not tell "production did not
 * ship" from "the failover did not refresh" — a Vercel secret not yet synced
 * once made `pnpm promote` report that the running app might not have moved,
 * while the serving target had shipped and been probed.
 *
 * Production is serving the commit exactly when the database job and the job
 * that deployed the thing holding spiralclass.com are both green. Since the
 * 2026-09-23 cutover ([D-184]'s addendum) that is Cloud Run; it was Fly before.
 * The failover is reported beside that verdict and never decides it.
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
  vercel: "Deploy the same commit to the Vercel failover, without taking the domain",
});

/** The targets that are deployed but serve no domain — reported, never decisive. */
export const STANDBYS = Object.freeze({
  vercel: "Vercel failover",
});

/**
 * @param {ReadonlyArray<{ name?: string; conclusion?: string | null; status?: string }>} jobs
 *   `.jobs` from `gh run view <id> --json jobs`.
 * @returns {{ productionOk: boolean; database: string; cloudrun: string; vercel: string }}
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
  const cloudrun = outcome(DEPLOY_JOBS.cloudrun);
  const vercel = outcome(DEPLOY_JOBS.vercel);

  return {
    productionOk: database === "success" && cloudrun === "success",
    database,
    cloudrun,
    vercel,
  };
}

/**
 * One line per standby, for the end of a promote. Derived from {@link STANDBYS}
 * rather than written per target, so a standby cannot be added to the workflow
 * and silently go unreported here.
 *
 * @param {{ vercel: string }} verdict from {@link deployVerdict}
 * @returns {string} one line per standby, newline-joined
 */
export function failoverLine(verdict) {
  return Object.entries(STANDBYS)
    .map(([key, label]) => {
      const outcome = verdict?.[key] ?? "missing";
      if (outcome === "success") return `  ${label}: refreshed, and holding no domain.`;
      if (outcome === "skipped") {
        return `  ${label}: skipped — it waits on the database job, never on Cloud Run.`;
      }
      return `  ⚠ ${label}: ${outcome}, so it did not refresh. That does not change whether production shipped.`;
    })
    .join("\n");
}
