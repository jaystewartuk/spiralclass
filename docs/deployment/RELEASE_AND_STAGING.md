# Release and preview runbook

The operator's half of a release: approving it, shipping by hand when the
runner cannot, rolling back, maintenance windows, the jobs nothing schedules,
and the one-time setup. How a merge becomes a release is
[`workflow.md`](../development/workflow.md#6-promote--it-happens-by-itself-and-you-approve-it);
this file does not restate it.

Policy: [D-199](../decisions/D-199.md) (a merge starts its own release),
[D-157](../decisions/D-157.md) (where the gate runs),
[D-184](../decisions/D-184.md) (Cloud Run), [D-178](../decisions/D-178.md)
(database rollback is Neon PITR plus checkpoint branches) and
[D-70](../decisions/D-70.md) (Vercel and Supabase are gone).

> [!IMPORTANT]
> **There is no preview host today.** Production serves from Cloud Run and its
> deploy is live. Preview has had no target since the Oracle box was destroyed
> ([D-16](../decisions/D-16.md)); [D-199](../decisions/D-199.md) decides it
> returns as a second Cloud Run service, `web-preview`, which is not built.
> Until then the manual pass runs locally, and merging to `main` deploys
> nothing but the production release below.

## Approving a release

When Gate and Heavy both finish green on the push run for a commit on `main`,
`promote-on-green.yml` fast-forwards `production`, and that push starts
`deploy-production.yml`. The run waits for the owner's approval on the
`production` environment — **once per job**: first the `database` job
(`scripts/database-deploy.sh production`: Neon checkpoint, then migrations),
then the `cloudrun` job (`scripts/cloudrun-deploy.sh production`: native amd64
image, `gcloud run deploy`, Inngest sync, production probes).

Approve outside lesson hours. Approving ships everything merged before it.

**What is live:** `git log origin/production`, Cloud Run's revision list (the
image tag is the commit) and the workflow's run history are authoritative.
`pnpm release:status` reads `.gate/release.json`, which only records what
_this_ machine shipped, so a runner deploy shows there as "no local record",
not "did not ship"; it exits 1 when something is behind.

### Promoting by hand

`pnpm promote` on an up-to-date `main` is the same script the workflow runs.
To ship an older reviewed commit, check it out first — promote certifies the
exact commit that ships.

- **`--force-gate`** — run the full tier here instead of reading the runners.
  The answer when a commit's runs have aged out of what GitHub keeps: an
  expired run is not a green one, and promote refuses.
- **`--no-wait`** — stop once `production` is fast-forwarded (`--no-deploy` is
  the old spelling of the same thing). It cannot suppress the deploy: the push
  is the trigger.

Promote watches the deploy run and exits non-zero if it goes red, so a green
promote means production is serving.

## Rollback

**Code:** `gcloud run revisions list --service web --region us-east4`, then
`gcloud run services update-traffic web --region us-east4
--to-revisions <revision>=100` to send traffic back to a known-good revision,
then `git revert` on `main` and let the fix take the normal path. Never
fast-forward `production` backwards. The revision's image must still exist;
`config/cloudrun/artifact-cleanup.json` keeps the five newest, which is the
rollback depth.

**This only rolls back code, never the database.** A code rollback does not
undo a migration or a bad data change. Restore the pre-migration Neon
checkpoint with `infra/database/scripts/neon-rollback.sh` —
[`DB_BACKUP_RESTORE.md`](./DB_BACKUP_RESTORE.md) is the procedure.

## Cloud Run serves production ([D-184](../decisions/D-184.md))

Production is Cloud Run service `web` in `us-east4`, the only production
target. Every release deploys to it as the `cloudrun` job, which `needs:` the
database job, holds only its own credentials, syncs Inngest against the domain,
probes production, and is the job promote reads to decide whether the release
shipped. A red `cloudrun` job means production did not move.

**Its secrets are one mounted file, not environment variables.**
`infra/gcp/push-cloudrun-env.sh` (operator) writes the whole runtime set as a
single Secret Manager version, and `scripts/docker-entrypoint.sh` sources it at
boot from the path in `SECRETS_ENV_FILE`. The deploy identity is never granted
`secretAccessor`, so CI can ship an image and cannot read a Stripe key.
[`infra/gcp/README.md`](../../infra/gcp/README.md) is the full account.

> [!WARNING]
> **A service whose secret was never written deploys fine and then will not
> start.** The preflight cannot catch it — it holds no credential to look with.

> [!WARNING]
> **The cold start is only acceptable because of a monitor.** HetrixTools
> `spiralclass production liveness` hits `/api/health/live` about once a
> minute, inside Cloud Run's idle keep, and follows the domain. Do not delete
> or re-point it, and keep it on `/api/health/live`: a sub-5-minute check
> against `/api/health` holds Neon's compute awake.

### Recovering a release by hand

If the deploy fails after the fast-forward, `production` has moved and the app
has not. Re-run the workflow, or — if Actions cannot run — deploy from the
laptop with the same two scripts, database first because the Cloud Run script
holds no database credential (operator only):

```bash
bash scripts/database-deploy.sh production --gate-already-passed
bash scripts/cloudrun-deploy.sh production --gate-already-passed
```

The second one ends by syncing Inngest against the domain.

### Leaving Cloud Run

There is no warm standby: Fly was destroyed at the cutover and the Vercel
failover was retired ([D-70](../decisions/D-70.md)). Leaving Cloud Run means
standing up a new target and following the section below.

### If the domain ever moves again

Every step is the operator's.

1. **Verify the new target by hand, signed in** — a booking page and a
   dashboard page. The probes cover the signed-out half only. A magic link is
   addressed to `APP_URL`, so signing in on a bare platform URL means editing
   the link's host.
2. **Map the domain.** On Cloud Run: `gcloud beta run domain-mappings create
--service web --domain spiralclass.com --region us-east4`, which first needs
   the domain verified in Search Console by the same Google account `gcloud`
   uses. It prints four A and four AAAA records.
3. **Replace the apex records at Cloudflare, DNS-only (grey cloud).** Google
   cannot issue the certificate through Cloudflare's proxy. ⚠️ **HTTPS is down
   from the moment the records change until the certificate reaches Google's
   front ends** — about fifteen minutes the last time. Do it outside lesson
   hours, and write the old records down first: putting them back is the
   rollback. `www` needs nothing; a Cloudflare redirect rule sends it to the
   apex at the edge.
4. **Move the Inngest registration — do not add one.** ⚠️ **The sharpest step on
   this page.** Inngest registers an app **per URL**, so syncing a second live
   URL registers a second app and every cron fires **twice**, including ones
   that bill Stripe customers. Sync the domain, never a platform URL, and check
   the Inngest dashboard shows exactly one production app.
5. **Watch one real class join, end to end.**
6. **Stop the old target; do not destroy it in the same breath.** Stopping
   keeps a rollback; destroying is a separate decision.

## Maintenance windows (taking the app offline)

For planned work that needs the app offline (a destructive migration, an infra
cutover), set the **`MAINTENANCE_MODE`** env flag — no code deploy to enter or
exit. The app serves a localized 503 wall; `/api/health` and
`/api/health/live` stay 200 so the uptime monitor does not flap. The flag is
env-driven rather than a database row because it has to be readable when the
database is the thing under maintenance (`apps/web/src/lib/maintenance.ts`).

**Enter:**

1. Set `MAINTENANCE_MODE=1` in every environment you are taking down. For
   production (operator only):
   `gcloud run services update web --region us-east4 --update-env-vars MAINTENANCE_MODE=1`.
   That rolls a new revision of the same image, and the container environment
   wins over the mounted secret file. ⚠️ `--update-env-vars`, never
   `--set-env-vars`, which replaces the service's whole environment.
   Optionally set `MAINTENANCE_MESSAGE="…"` and `MAINTENANCE_UNTIL="18:00 CST"`
   for custom copy and an ETA, and `MAINTENANCE_BYPASS_TOKEN=<random>` to let
   yourself through.
2. Verify the wall — an incognito hit to any page returns it.
3. Do the work.
4. Verify on the real site via `https://…/?maintenance_bypass=<token>`, which
   sets a cookie so the rest of your session is live while everyone else is
   walled.

**Exit:** `gcloud run services update web --region us-east4
--remove-env-vars MAINTENANCE_MODE` (another revision), and the same for
`MAINTENANCE_MESSAGE`, `MAINTENANCE_UNTIL` and `MAINTENANCE_BYPASS_TOKEN` if
you set them. Confirm the app is live and `/api/health` is green.

## Maintenance jobs

Nothing is scheduled ([D-157](../decisions/D-157.md)): no `schedule:` trigger,
no cron, no launchd agent. Two jobs are commands, registered in
`scripts/local/jobs.mjs`:

```sh
pnpm local synthetic     # probe production: every public surface, body-marked
pnpm local sweep         # unit suites + audit, against today's date
pnpm local:status        # when each last succeeded, and what is overdue
```

The probes also run as the last step of every production deploy, and promote
records that run's success, so their clock clears on a deploy.

The risk is not forgetting a job — it is not knowing you forgot. So:

- Every run writes a receipt to `.gate/local-jobs.json` (gitignored), keeping
  the last run and the last _successful_ run separately, so a week of failures
  never reads as fresh.
- **`pnpm gate` prints one line per job not successful within seven days**, and
  the pre-push hook runs the gate on every push. It never fails the gate.
- A failed run alerts by ntfy (when `NTFY_URL` and `NTFY_TOPIC` resolve) and by
  a macOS notification. Both fail open.

**There is deliberately no backup job.** Neon backs production up;
`scripts/local/backup-prod-db.sh` is an unregistered on-demand tool, described
in [`DB_BACKUP_RESTORE.md`](./DB_BACKUP_RESTORE.md). **A shut laptop runs none
of this** — the gap D-157 accepts.

## One-time setup (manual — off lesson hours)

### 1. Preview Neon project

- Create a disposable **Neon preview project**, separate from production.
- Put the preview `DATABASE_URL` and `DIRECT_URL` in Infisical's `preview`
  environment — `DIRECT_URL` over the **direct** connection, not the pooler,
  which breaks the seed's prepared statements — then run
  `pnpm --filter spiralclass-web migrate:preview` and `pnpm seed:preview`. Both
  read the values from Infisical at run time and write no env file
  (`infra/infisical/seed-preview.sh`). The seed refuses to run against the
  production ref.
- The seed has two layers (`apps/web/scripts/seed.ts`): a **deterministic core**
  — Alicia Moreno (the E2E teacher) plus "hero" teachers covering the
  subscription matrix and both payment rails — and **optional bulk volume**:
  `SEED_BULK_TEACHERS=40 pnpm seed:preview` (`SEED_BULK_STUDENTS_PER_TEACHER`
  defaults to 6). CI seeds the core only.
- **Signing in to preview:** the hero teachers use real `profe.*` addresses on
  the product domain (request a magic link at `/sign-in`); Alicia Moreno and her
  students use `*.test` addresses, reachable only through superadmin
  **impersonation** at `/admin`, which shows the link in the UI. Reaching
  `/admin` needs your email in preview's `SUPERUSER_EMAILS`, plus MFA.

### 2. Cloud Run production service

- Create a `production` branch at the current `main` HEAD.
- The service's one-time setup — the deploy identity, the runtime secret, the
  image cleanup policy, the budget alert — is
  [`infra/gcp/README.md`](../../infra/gcp/README.md), in that order; the
  domain mapping is [above](#if-the-domain-ever-moves-again).
- **Runtime secrets** live in Infisical and reach the service as one mounted
  Secret Manager file, written by `infra/gcp/push-cloudrun-env.sh`. A running
  revision keeps the version it started with, so a changed secret is live only
  after the next deploy.
- **prod-vs-preview is decided by `APP_URL`**; the preview `noindex` header keys
  off the `NEXT_PUBLIC_DEPLOY_ENV` build arg. Preview, when it has a host, gets
  **sandbox** Stripe, Wise, Meta and Resend keys — never live ones.
- `NEXT_PUBLIC_*` values are inlined at build time, which is why production is
  a rebuild, not a promoted preview artifact ([D-199](../decisions/D-199.md)).
- **Server Action skew:** when a browser running a previous deploy posts a
  stale Server Action ID and hits `Failed to find Server Action "…"`, the
  client reloads to pick up the current bundle
  (`apps/web/src/lib/server-action-recovery.ts`). It is the only mechanism.

### 3. GitHub

- Branch protection, the `production` rulesets, the `production` and `promote`
  environments and `PROMOTE_TOKEN` are all in
  [`BRANCH_PROTECTION.md`](./BRANCH_PROTECTION.md); re-apply with
  `scripts/setup-branch-protection.sh` after any drift.
- A hand-typed `pnpm promote` pushes with **your own** git credentials, and
  wants `gh` authenticated on the machine to read the runners' verdict and cut
  the release tag.

### 4. Feature flags

Dark-launch with `flagEnabled("FLAG_<NAME>")` (`apps/web/src/lib/flags.ts`):
set `FLAG_<NAME>=on` in preview's runtime environment, leave it unset in
production, and set it there when the feature is ready
([`workflow.md`](../development/workflow.md#feature-flags)).

## Migrations (live data)

Keep changes **expand/contract** — additive first; a drop or rename is a
deliberate two-step release. `heavy.yml`'s integration step applies the
migrations to a fresh database on every PR and every push to `main`, so a
broken migration fails before production.
