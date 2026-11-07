# Production database backup and restore

What protects production's data, and the fastest safe recovery when a
migration or a bad data change needs undoing. Policy:
[D-178](../decisions/D-178.md) (Neon PITR plus pre-migration checkpoints) and
[D-157](../decisions/D-157.md) (no scheduled backup job). Production's database
is a managed Neon project ([D-184](../decisions/D-184.md)).

## What protects production

**Primary: Neon point-in-time restore (PITR) plus a pre-migration checkpoint
branch.** Neon retains WAL history for every branch, so any point inside the
project's restore window is recoverable with no action here. The window is set
by the Neon plan; the account was on Neon's Free plan when last measured
([`infra/database/neon/README.md`](../../infra/database/neon/README.md)) —
read the current window in the Neon console rather than assuming one.

On top of that, `scripts/database-deploy.sh` runs
`infra/database/scripts/neon-checkpoint.sh` immediately before every production
migration, creating a branch named `pre-deploy-<UTC timestamp>-<sha>` off
`production`. A Neon branch is copy-on-write, so creating one takes seconds at
any database size. `deploy-production.yml`'s `database` job runs that script
on every release, and the operator runs the same script to recover a release
by hand, so every production migration goes through it.

- **It fails closed.** An unauthenticated `neonctl`, a missing
  `NEON_PROJECT_ID` or a failed branch-create stops the deploy before any
  migration runs.
- **`NEON_PROJECT_ID` has no default** — a public repository cannot carry the
  production project id ([D-158](../decisions/D-158.md)). It is the
  `production` environment secret on the runner; export it for a laptop run
  (`neonctl projects list`).
- **Authentication:** `NEON_API_KEY` when it is set (the runner), otherwise the
  credential `neonctl auth` stored on this machine — run `neonctl auth` once per
  machine (`ensure_neon_auth` in `infra/database/scripts/_common.sh`). An OAuth
  credential can expire; the error names `neonctl auth`.
- **Retention:** the 5 most recent checkpoints per parent are kept and older
  ones pruned in the same step. The number lives once, as `KEEP` in
  `neon-checkpoint.sh` (pinned by
  `apps/web/tests/config/neon-checkpoint-retention.test.ts`), and
  `apps/web/tests/config/local-gate.test.ts` pins the checkpoint-before-migrate
  ordering.
- **Branch limit:** Neon caps branches per project (`owner.branches_limit`), and
  `production` plus any ad-hoc branches count against it. The script reads the
  live limit and **refuses before creating anything** if the retention would
  not fit, rather than failing partway through a deploy.
- **No compute:** checkpoints are created with `--no-compute`, since the
  rollback never connects to them. To read one, attach a compute on demand:
  `neonctl branches add-compute <name>`.

**Secondary, off-platform: `scripts/local/backup-prod-db.sh`, on demand only.**
A `pg_dump -Fc` → verify → upload to R2, run by hand from the operator's
machine when you want a copy that lives outside Neon entirely — before a
migration risky enough to justify it. There is no `pnpm local backup`, no
registered job and no staleness nag ([D-157](../decisions/D-157.md) records
what that gives up: a Neon-account-level incident, and anything noticed after
the restore window closes).

Before a run, five values must resolve from the environment or Infisical's
`production` environment: `PROD_BACKUP_DB_URL`, `R2_BACKUP_BUCKET`,
`R2_BACKUP_ENDPOINT`, `R2_BACKUP_ACCESS_KEY`, `R2_BACKUP_SECRET` (plus
`NTFY_URL` / `NTFY_TOPIC` for the phone alert). It **fails closed** on any
missing value, a failed dump or a dump that does not verify. It needs `libpq`
(`brew install libpq`; the script finds the newest client on the machine,
because a client older than the server cannot dump it) and `awscli`.
`PROD_BACKUP_DB_URL` must be the production Neon project's **direct**
connection string; check it against the Neon console before trusting a dump.

## Known gaps

- **No checkpoint independent of a deploy.** Between deploys, PITR alone
  protects production. Before a risky manual database operation, run
  `infra/database/scripts/neon-checkpoint.sh --parent production` by hand.
- **The `migrate:prod` script bypasses the checkpoint.** It runs
  `apps/web/scripts/migrate-regions.ts` (`prisma migrate deploy`) through
  `infra/infisical/run.sh production` from a developer's machine, outside both
  deploy paths. Operator only; checkpoint by hand first.
- **PITR is bounded by the plan's window.** A checkpoint branch persists until
  pruned, so it covers its own moment for longer than PITR does — "a bad
  migration shipped Monday, noticed Wednesday" is why retention is more than 1.
- **An R2 dump is a snapshot.** Writes after it are not in it.
- **No restore drill has been run.** Nobody has run `neon-rollback.sh` against
  a real incident. Rehearse it — checkpoint a scratch branch, restore it,
  verify — before relying on it under pressure.

## Rollback — a production migration fails or ships bad data

Neon branching plus PITR through `neon-rollback.sh` is the fast path. The R2
dump is the fallback for an incident outside both PITR and checkpoint coverage.

1. **Set `MAINTENANCE_MODE=1`**
   ([`RELEASE_AND_STAGING.md`](./RELEASE_AND_STAGING.md#maintenance-windows-taking-the-app-offline))
   if the incident involves bad or corrupted data, not just a code bug — stop
   further writes before touching the database.
2. **Find the restore point.**
   ```sh
   NEON_PROJECT_ID=… infra/database/scripts/neon-rollback.sh --list
   ```
   Lists checkpoint branches newest-first. Pick the one from right before the
   bad deploy, or use `--timestamp <RFC3339>` instead if the incident was not
   deploy-shaped (a bad admin action, a bug at a known moment).
3. **Restore.**
   ```sh
   infra/database/scripts/neon-rollback.sh --from pre-deploy-<timestamp>-<sha>
   ```
   Neon's own restore — seconds, at any size. The script preserves
   `production`'s pre-restore state under a new branch first
   (`--preserve-under-name`), so a wrong restore point is itself undoable.
4. **Verify** — row counts on a few key tables (`teachers`, `bookings`,
   `payments`), and a real record spot-checked by hand.
5. If the bad migration only changed schema and destroyed no data, a
   **forward** migration that reverses it may be simpler than a restore.
6. Exit maintenance mode once verified.

## Restoring from an R2 dump (past Neon's coverage)

1. **List the dumps:**
   ```sh
   aws s3 ls "s3://$R2_BACKUP_BUCKET/" --endpoint-url "$R2_BACKUP_ENDPOINT"
   ```
2. **Download one:**
   ```sh
   aws s3 cp "s3://$R2_BACKUP_BUCKET/<dump file>" ./restore.dump \
     --endpoint-url "$R2_BACKUP_ENDPOINT"
   ```
3. **Provision a restore target.** Never restore over a live database first —
   restore into a _new_ target, verify it, then cut over. Prefer a new Neon
   branch (`neonctl branches create`); a throwaway Postgres instance whose
   major is at least the dump's also works if you need a target off Neon.
4. **Restore:**
   ```sh
   pg_restore --no-owner --no-privileges --clean --if-exists \
     -d "$TARGET_DIRECT_URL" restore.dump
   ```
   `--clean --if-exists` drops conflicting objects first, so it is safe to
   re-run against the same target.
5. **Verify** — row counts on key tables and a real record by hand; an exit
   code of 0 is not verification.
6. **Cut over** — enter maintenance mode, repoint `DATABASE_URL` / `DIRECT_URL`
   in Infisical `production` at the restored target, re-run
   `infra/gcp/push-cloudrun-env.sh` (operator), and deploy so a new revision
   mounts the new secret version (a running revision keeps the one it started
   with). The `production` GitHub environment holds its own copy of those two
   values, read by the deploy's `database` job; re-push it too
   (`infra/infisical/push-github-secrets.sh`). Verify `/api/health` and a real
   sign-in, then exit maintenance mode.

If only some data was corrupted, restoring into a scratch target and
reconciling just the affected rows into production is a smaller blast radius
than a full cutover, which loses every write since the snapshot. Either is
tens of minutes to hours — why the Neon path is preferred whenever it covers
the incident.
