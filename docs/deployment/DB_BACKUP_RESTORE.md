# Production DB backup & restore

This is the operator runbook for production database safety: what protects
production today, how to check on it, and the fastest safe recovery procedure
if a migration or bad data change needs undoing. Rewritten 2026-07-20 (D-95)
after the D-70 Fly + Neon cutover was confirmed executed (D-89) — production
is now confirmed on Neon (see "How do I know production is actually on Neon?"
below), which changes the right primary mechanism from a pg_dump snapshot to
Neon's own point-in-time restore (PITR) and branching.

## What protects production today

**Primary: Neon point-in-time restore (PITR) + a pre-migration checkpoint
branch.** Neon continuously retains WAL history for every branch, so any
point within the project's retention window (plan-dependent — 6h on Free,
7 days on Launch, 30 days on Scale and above; confirm which plan the
production Neon project is on) is recoverable, automatically, with no action
needed here. On top of that, every path that migrates production runs
`infra/database/scripts/neon-checkpoint.sh` immediately before the migration,
creating a named branch — `pre-deploy-<UTC timestamp>-<sha>` — off
`production`'s current state. A Neon branch is copy-on-write against that same
WAL history, so creating one is seconds regardless of database size. The
checkpoint **fails closed**: an unauthenticated `neonctl`, a missing
`NEON_PROJECT_ID`, or a failed branch-create blocks the deploy before any
migration runs.

**One call site** — `scripts/fly-deploy.sh`. `pnpm promote` chains this script,
so it is what every production deploy runs. It requires `NEON_PROJECT_ID` and
does **not** default it — the default used to be the production project id
written out in full, which a public repository cannot carry ([D-158]); supply it
as the repository variable, or export it for a laptop deploy
(`neonctl projects list`). It fetches no key: `neonctl` authenticates with
the credential `neonctl auth` stores on this machine, or with `NEON_API_KEY` if
one happens to be exported (2026-08-31 — see `ensure_neon_auth` in
`infra/database/scripts/_common.sh`). **Run `neonctl auth` once per machine**;
without it the checkpoint fails closed and says so. (There were two paths between D-120 and D-129, the second being
`fly-deploy.yml`'s `production` job via the `neon-checkpoint` composite action.
Both are deleted — D-129 removed every workflow and composite action in this
repo — so there is no runner-side deploy left to keep in sync.)

Old checkpoints beyond the most recent 5 (per branch, tunable via `--keep`) are
pruned automatically in the same step. The retention number lives once, in
`neon-checkpoint.sh`; `apps/web/tests/config/local-gate.test.ts` pins the
local script's checkpoint-before-migrate ordering, so the D-120 regression that
dropped it from the local path can't recur silently.

Retention is bounded from both directions and the script enforces the upper
one. Neon caps branches per project (10 on the production project's plan,
`owner.branches_limit`), and `production` itself plus any ad-hoc branches eat
into that — so `neon-checkpoint.sh` reads the live limit and **refuses before
creating anything** if `--keep` plus the non-checkpoint branches wouldn't fit,
rather than letting it surface as an opaque "branches limit exceeded" partway
through a production deploy. Checkpoints are created **without a compute
endpoint** (`--no-compute`): the rollback path never connects to them (see
below), so an endpoint would only be something that could be woken by
accident. To read a checkpoint's data directly, attach one on demand with
`neonctl branches add-compute <name>`.

**Secondary, off-platform: `scripts/local/backup-prod-db.sh` — ON DEMAND, NOT A
ROUTINE.** ⚠️ **Decided 2026-08-25** ([D-129](../decisions/D-129.md) addendum):
**Neon backs production up**, so there is no `pnpm local backup`, no registered
job and no staleness nag. Run this by hand when you specifically want a copy
that lives outside Neon — before a migration risky enough to justify it. What
that gives up (a Neon-account-level incident, and anything noticed after the
PITR window closes) is written down in the addendum. The rest of this section
describes the script as it stands. A `pg_dump -Fc` → verify →
upload-to-R2 job (`scripts/local/backup-prod-db.sh`), same contract as before
D-95, and **run by hand from the operator's machine** — D-129 deleted
`backup-prod-db.yml` along with every other workflow. It does not gate a deploy
and never did after D-95. Run it before something risky enough to want a copy
that survives a Neon-account-level incident or outlives Neon's PITR retention
window, and otherwise about weekly. It is not routine deploy hygiene; Neon's
PITR + the checkpoint branch cover that faster and more reliably (and without
the pg_dump/pg_restore client-version fragility that broke this exact job on
2026-07-20 — the script resolves the newest client on the machine rather than
pinning a major, for that reason).

**You do not find out it has not run, and that is now intentional.** The
staleness receipt and the `pnpm gate` nag that D-129 built for this job went
with the job itself on 2026-08-25 — a standing warning about a decision already
made trains you to skim the banner the other jobs depend on. Production's
recovery story is Neon's, above.

**Before any hand run**, five values have to be in Infisical's `production`
environment (they were GitHub repo secrets, which nothing reads now):
`PROD_BACKUP_DB_URL`, `R2_BACKUP_BUCKET`, `R2_BACKUP_ENDPOINT`,
`R2_BACKUP_ACCESS_KEY`, `R2_BACKUP_SECRET` — plus `NTFY_URL` / `NTFY_TOPIC` for
the phone alert on failure. The script reads the environment first, falls back
to Infisical, and **fails closed** on any missing value: a missing secret, a
failed dump, or a dump that does not verify is an error, never a skip. It needs
`libpq` (`brew install libpq`) and `awscli` on the machine.

**Which database does the backup actually back up?** The Neon
cutover **has been executed** (D-89; `docs/decisions/D-89.md`).
Production runs on the Fly app `agendaprofe` + a **Neon production project**;
Vercel and Supabase are decommissioned (D-89 Phase 5). `PROD_BACKUP_DB_URL`
was repointed to the Neon production project's direct connection string at
cutover, in the same step that `PROD_DATABASE_URL`/`PROD_DIRECT_URL` were set
(`PRODUCTION_CUTOVER.md` Phase 3) — otherwise the job would keep "succeeding"
while quietly backing up a database nothing serves anymore. That value now lives
in Infisical rather than in a repo secret.

### How do I know production is actually on Neon?

It is. This was ambiguous in this doc's previous version — `PRODUCTION_CUTOVER.md`
and `D-70.md` were (and largely still are, as historical records) written
_before_ execution and say "not yet executed". The evidence it happened is on
the record twice over: the D-70 move to Neon put production on PG 18, which
broke the backup job's pinned pg_dump client on 2026-07-20 (why the script now
resolves the newest client instead of pinning), and `scripts/fly-deploy.sh` /
`CLAUDE.md` both describe production deploying to Fly as current, running fact.
If you're ever unsure again, check `scripts/fly-deploy.sh`'s production env
(`PROD_DATABASE_URL`/`PROD_DIRECT_URL`) against the actual Neon console —
that's the one source that can't drift from reality.

## What this does NOT cover (known gaps)

- **No periodic/scheduled checkpoint independent of a deploy.** The Neon
  checkpoint only runs when a deploy runs (`pnpm promote` → `fly-deploy.sh`).
  Between deploys, PITR alone is your protection — which is fine, since PITR is
  continuous and doesn't depend on anything in this repo running, but there's
  no _named_ checkpoint for "an ordinary
  Tuesday, no deploy happened" the way there is for "right before this
  deploy." If you need one anyway (e.g. before a risky manual DB operation),
  run `neon-checkpoint.sh` by hand.
- **Direct push to `production` bypasses the checkpoint entirely, same as it
  always could.** Branch protection is deliberately not enabled on
  `production` (`CLAUDE.md`) — a direct `git push origin <sha>:production` by
  anyone with push access no longer deploys anything at all (D-120 removed
  fly-deploy.yml's push trigger; D-129 removed the workflow) — the branch moves and production keeps
  serving the old image, unmigrated and uncheckpointed, until someone runs the
  deploy. The remaining real gap is the `migrate:prod` script, which runs
  `prisma migrate deploy` straight from a developer's machine against
  `.env.production.local`, bypassing both deploy paths and the checkpoint with
  them. This is a process/discipline gap; run
  `neon-checkpoint.sh --parent production` by hand first if you're about to use
  that escape hatch.
- **PITR is bounded by the Neon project's plan.** Anything older than the
  retention window is gone unless a checkpoint branch (or an R2 dump) covers
  it. Checkpoint branches persist until pruned (5 most recent, by default),
  so in practice a checkpoint outlives PITR itself for the specific moments it
  was taken — 5 deploys' worth of named restore points is days of depth at the
  current deploy rate, against a PITR window measured in hours. That gap is
  exactly why retention is not simply 1: "a bad migration shipped Monday,
  noticed Wednesday" is outside PITR and inside checkpoint coverage.
- **The R2 dump is a point-in-time snapshot, not continuous protection.**
  Any write between the snapshot and an incident is unrecoverable from that
  backup alone — it's the off-platform, longer-retention fallback, not the
  primary mechanism (see above).
- **No live-restore drill.** Nobody has actually run `neon-rollback.sh`
  against a real incident yet. Do a dry run — checkpoint a branch, restore
  from it into a scratch target, verify — at least once before relying on it
  under pressure.

## Rollback procedure — a production migration fails or ships bad data

**Production is on Neon (D-89), so Neon branching + PITR via
`neon-rollback.sh` is THE fast path.** The R2 dump restore below is the
fallback for when the incident falls outside Neon's PITR retention window
(and no checkpoint branch covers it either), or you need a target off Neon
entirely.

1. **Flip `MAINTENANCE_MODE=1`** (`RELEASE_AND_STAGING.md`) if the incident
   involves bad/corrupted data, not just a code bug — stop further writes
   before touching the database.
2. **Find your restore point.**
   ```sh
   NEON_PROJECT_ID=… infra/database/scripts/neon-rollback.sh --list
   ```
   Lists checkpoint branches newest-first. Pick the one from right before the
   bad deploy, or use `--timestamp <RFC3339>` instead if the incident wasn't
   deploy-shaped (a bad admin action, an application bug at a known moment).
3. **Restore.**
   ```sh
   infra/database/scripts/neon-rollback.sh --from pre-deploy-2026-07-20T143200Z-abc1234
   ```
   This is Neon's own instant restore — seconds, not a pg_dump/pg_restore
   cycle, regardless of database size. It automatically preserves
   `production`'s pre-restore state under a new branch first (the script
   passes `--preserve-under-name` explicitly), so the restore itself is
   undoable if the wrong point was chosen.
4. **Verify** — row counts on a few key tables (`teachers`, `bookings`,
   `payments`), spot-check a real record by hand before trusting it.
5. If the bad migration only changed schema and no data was lost, consider
   whether a **forward** migration that reverses it is actually simpler than
   a full restore — Prisma migrations aren't designed to be replayed
   backwards, but a schema-only mistake with no destroyed data doesn't
   necessarily need a restore at all.
6. Exit maintenance mode once verified.

**This is a major payoff of the Neon cutover** (`PRODUCTION_CUTOVER.md`, D-89)
from a disaster-recovery standpoint, independent of any other cutover
motivation: PITR + branching turns "restore prod" from an hours-scale manual
operation into a minutes-scale, low-risk one.

**If the incident is older than the Neon project's PITR window** and no
checkpoint branch covers it (a real gap only for very old incidents, given
checkpoints persist past pruning-eligible age): fall back to the R2 dump path
below.

## Restoring from an R2 dump (fallback, past Neon's coverage)

1. **List available dumps:**
   ```sh
   aws s3 ls "s3://agendaprofe-backups/" --endpoint-url "$R2_BACKUP_ENDPOINT"
   ```
2. **Download the one you want:**
   ```sh
   aws s3 cp "s3://agendaprofe-backups/prod-2026-07-19T030000Z.dump" ./restore.dump \
     --endpoint-url "$R2_BACKUP_ENDPOINT"
   ```
3. **Provision a restore target.** Never restore over a live database
   in-place as the first step — restore into a _new_ target, verify it, then
   cut over. Prefer a **new Neon branch** (`neonctl branches create`, or the
   Neon-native rollback procedure above — it's both faster and safer than a
   `pg_restore`); a throwaway Postgres 17+ instance also works if you need a
   target off Neon entirely.
4. **Restore:**
   ```sh
   pg_restore --no-owner --no-privileges --clean --if-exists \
     -d "$TARGET_DIRECT_URL" restore.dump
   ```
   `--clean --if-exists` drops conflicting objects first, so this is safe to
   re-run against the same empty-ish target.
5. **Verify** — row counts on a few key tables (`teachers`, `bookings`,
   `payments`), spot-check a real record by hand. Don't trust "the command
   exited 0" alone.
6. **Cut over** — put the app in maintenance mode
   (`RELEASE_AND_STAGING.md`'s Maintenance windows section), repoint
   `PROD_DATABASE_URL`/`PROD_DIRECT_URL` (Fly secrets: `fly secrets set … -a
spiralclass`) at the restored target, redeploy/restart, verify
   `/api/health` and a real sign-in, exit maintenance mode.

If data was only partially corrupted rather than needing a wholesale cutover,
consider restoring into a scratch target and manually reconciling just the
affected rows/tables back into production via targeted `INSERT`/`UPDATE`
(lower blast radius, more manual work) instead of a full cutover (faster, but
loses every write since the snapshot was taken). Neither is fast — a full
`pg_dump`/`pg_restore` cycle plus reconciliation is realistically tens of
minutes to hours, which is exactly why the Neon-native path above is
preferred whenever the incident is within PITR/checkpoint coverage.

## Recommendations not implemented by this audit (operator decisions)

1. **Confirm the production Neon project's plan/retention window** and
   record it here once known — this doc currently can't say whether
   production has 6h, 7d, or 30d of PITR coverage, which materially changes
   how much the checkpoint-branch pruning window (`--keep 5`) and the R2
   fallback actually matter.
2. **Keep `neonctl` authenticated on the deploy machine** — `neonctl auth`,
   once, per machine. `scripts/fly-deploy.sh`'s checkpoint step fails closed
   without it, which blocks the next production deploy. This replaced the
   `NEON_API_KEY` in Infisical's `infra` environment on 2026-08-31, after the
   keys were deleted and a promote stopped with `production` fast-forwarded and
   the app still on the previous release. An OAuth credential can expire, so
   the same failure is still possible — the error names `neonctl auth`.
   See `infra/database/neon/README.md`.
3. **An actual restore drill.** Pick a quiet window, checkpoint a scratch
   branch, restore it, and confirm the whole procedure above works
   end-to-end. Nothing here has been exercised for real yet.
4. **Branch protection on `production`** — unchanged from the previous
   recommendation, still not implemented, and now largely moot: branch
   protection is a paid feature on private repos on this plan, and there is no
   `PROMOTE_TOKEN` actor left to allow, since promoting is a local command
   (D-119/D-129). `CLAUDE.md` documents the opposite as deliberate.
