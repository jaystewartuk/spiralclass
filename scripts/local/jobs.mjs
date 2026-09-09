// The three maintenance tasks that used to run on a GitHub Actions cron, and
// the staleness budget each one gets now that it is run BY HAND (D-129).
//
// Until 2026-08-25 these were `schedule:` crons in .github/workflows, and D-129
// deleted them: the private-repo minutes allowance kept running out, and an
// allowance that empties mid-month takes the *backup* down with everything
// else. Nothing replaced the clock, and D-157 did not bring one back — its
// scope is deliberately the gate and the deploys, not `schedule:` triggers.
// These are still commands the operator runs.
//
// Which leaves exactly one problem worth engineering, and it is not "who starts
// the job". It is that a task nobody ran looks precisely like a task that ran
// fine. Two mechanisms answer it:
//
//   1. Every run writes a receipt (`run.mjs`), so "when did this last succeed"
//      is a fact on disk rather than an inference from an empty inbox.
//   2. `staleAfterHours` turns that fact into a warning at the one moment the
//      operator is provably at the keyboard — the end of every `pnpm gate`,
//      which the pre-push hook runs on every push.
//
// The budgets below are therefore a nag interval, not a cadence, and they are
// deliberately loose. A banner that fires every day is a banner nobody reads,
// and the thing it is protecting is a backup.
//
// The probes are the exception to "by hand". They run automatically once
// production is serving the new code, because that is the moment they detect
// something — as the last step of .github/workflows/deploy-production.yml
// since D-157, and inside `pnpm promote` before that. `pnpm promote` records
// the receipt when that workflow finishes green, so the staleness clock below
// still clears on a deploy and the nag keeps meaning what it says.
//
// THERE IS NO `backup` JOB HERE, and that is deliberate as of 2026-08-25
// (D-129 addendum). The operator's call: **Neon already backs production up**,
// so a hand-run pg_dump to R2 is not a practice worth keeping. What that gives
// up is stated in the addendum rather than left to be discovered — the dump was
// the copy that lived outside Neon entirely and the one that outlived the PITR
// window. `scripts/local/backup-prod-db.sh` is KEPT as an on-demand tool for
// the case that still wants one (before a migration risky enough to want a copy
// off-platform), but it is not registered here, so nothing nags about it. A job
// nobody intends to run must not be in this list: a standing warning for a
// decision already made is exactly the banner-nobody-reads failure the nag
// exists to avoid.

/**
 * @typedef {Object} Job
 * @property {string}   id              CLI handle and receipt key
 * @property {string}   title           what gets printed
 * @property {string[]} cmd             argv, run from the repo root
 * @property {number}   staleAfterHours how long since the last SUCCESS before
 *   `pnpm gate` warns about it
 * @property {"urgent"|"high"|"default"} urgency  ntfy priority on failure
 * @property {string}   why             one line, printed by `pnpm local:status`
 */

/** @type {Job[]} */
export const JOBS = [
  {
    id: "synthetic",
    title: "Production synthetic probes",
    cmd: ["bash", "scripts/local/synthetic.sh"],
    // Mostly self-clearing: the production deploy runs this every time, so a
    // week of staleness means a week without a deploy, which is exactly when a
    // hand-run probe is worth prompting for.
    staleAfterHours: 24 * 7,
    urgency: "high",
    why: "catches deploy-broke-prod and route-render regressions that /api/health returns 200 through",
  },
  {
    id: "sweep",
    title: "Time-bomb sweep (unit suites + audit against today's clock)",
    cmd: ["bash", "scripts/local/sweep.sh"],
    // This detects a class of failure measured in weeks — a test whose
    // assertion holds only on one side of a hard-coded date — so a quiet
    // weekend costs nothing real. It also runs incidentally: the same suites
    // are in the fast gate on every push, against the same clock.
    staleAfterHours: 24 * 7,
    urgency: "default",
    why: "the one failure class a push-time gate cannot catch on its own — a clock that advanced",
  },
];

/** @param {string} id */
export function jobById(id) {
  return JOBS.find((j) => j.id === id);
}

export const JOB_IDS = JOBS.map((j) => j.id);
