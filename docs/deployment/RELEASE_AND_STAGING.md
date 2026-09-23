# Release & preview runbook

Policy: **D-26**, superseded in part by **D-70** (production moved from
Vercel+Supabase to Fly+Neon), **D-95** (database rollback moved from an R2
pg_dump to Neon PITR + checkpoint branches), **D-119** (the test gates run on
the operator's machine), **D-129** (which deleted every GitHub Actions
workflow), **D-157** (which brought the workflows back once the
repository went public and the minutes became free) and
**D-161**/**D-162** (which moved the heavy suites onto runners and made their
verdict what promote reads). The release/promote/rollback gate structure below
is current.

⚠️ **There is no preview host today; production's deploy is live.**
Production serves from Cloud Run ([D-184](../decisions/D-184.md)'s addendum)
and `deploy-production.yml`'s `push` trigger is live — `pnpm promote` reads
that trigger off the workflow file and refuses before the fast-forward if it is
ever missing. Preview moved to the Oracle A1 box
([D-150](../decisions/D-150.md)), which was destroyed on 2026-09-19
([D-182](../decisions/D-182.md)); preview has no deploy target until it is
rebuilt, and `scripts/oracle-deploy.sh` is the way back. Merging to `main`
deploys nothing. Production's recovery path from the laptop is
[below](#recovering-a-release-by-hand).

This file is the operator runbook — the one-time setup, the everyday release
flow, and rollback.

## Everyday release flow

1. Branch, commit, `git push` — the pre-push hook runs the fast gate on your
   machine and posts the `local-gate` status once the push lands (D-119). Open a
   PR into `main`; when that status is green on the PR head, branch protection
   unlocks the merge button. (No laptop? **`gate.yml` posts the same context on
   the PR** — D-157 — so the PR is not stranded. Say plainly which run you saw,
   and never imply you posted a status you did not.) Merge. There is no preview
   to ship to until the Oracle box is rebuilt, so the manual pass runs locally.

2. _(Optional)_ Run **`pnpm gate:full`** on `main` — fast tier + mutation +
   integration + E2E + a no-push image build, and it **deploys nothing**. The gate is hermetic: it
   validates the _commit_, so a green run means the version you're about to
   hand-test is the version that will clear promote. Usually unnecessary now —
   **`heavy.yml` runs that same half on every PR and every push to `main`**
   ([D-161](../decisions/D-161.md)), and promote reads its verdict. Spend the
   20-40 minute local hold only when you need the answer before the PR is open.
3. When ready (and **outside lesson hours**), with `main` checked out and
   up to date, run **`pnpm promote`**. To ship an older reviewed commit, check
   it out first — the gate certifies the exact commit that ships.
4. It **reads the runners' verdict** for that exact commit — Gate and Heavy
   both green for the SHA ([D-162](../decisions/D-162.md)) — asks for
   confirmation, fast-forwards the `production` branch and stamps a
   `vYYYY.MM.DD.N` tag + GitHub Release. **That push triggers
   `deploy-production.yml`.**
   - An older commit may have aged out of what GitHub still keeps; an expired
     run is not a green one, so promote refuses. **`--force-gate`** certifies it
     on this machine instead.
5. The workflow, after a **required reviewer**, runs the same scripts the
   operator runs by hand: `scripts/database-deploy.sh production` (checkpoint
   the Neon `production` branch → migrations), then
   `scripts/cloudrun-deploy.sh production` (**native amd64** image →
   `gcloud run deploy` → Inngest sync), then the **production probes** against
   the live site. `pnpm promote` watches that run and exits non-zero if it goes
   red, so a green promote means production is serving.
   - If the deploy fails _after_ the fast-forward, the branch moved and the app
     did not. Re-run the workflow, or run the same two scripts from here — see
     [Recovering a release by hand](#recovering-a-release-by-hand).
6. `pnpm release:status` for what this machine has and hasn't shipped, and
   `pnpm local:status` for whether the probes and the sweep are current.

## Rollback

**Code:** `gcloud run revisions list --service web --region us-east4` to see
recent revisions, then `gcloud run services update-traffic web --region us-east4
--to-revisions <revision>=100` to send traffic back to a known-good one, then
`git revert` on `main` when fixed. Do **not** fast-forward `production`
backwards; roll forward to a new commit or re-point at a previous revision
instead. Only the five newest images are kept, so that is the rollback depth.

**This only rolls back code, never the database.** A code rollback does not
undo a migration or bad data change. `scripts/database-deploy.sh` checkpoints
the Neon `production` branch before every production migration (D-95) —
restore it in seconds with `infra/database/scripts/neon-rollback.sh`, Neon's
own point-in-time restore. See [`DB_BACKUP_RESTORE.md`](./DB_BACKUP_RESTORE.md) for the full
restore procedure and the fastest safe recovery path for a failed migration.

## Cloud Run serves production ([D-184](../decisions/D-184.md))

**Cloud Run `web` in `us-east4` has served `spiralclass.com` since 2026-09-23.**
Fly `agendaprofe` was destroyed the same day. Every production release deploys
to it as the `cloudrun` job, which `needs:` the database job, holds only its
own credentials, syncs Inngest against the domain, probes
production, and is the job `pnpm promote` reads to decide whether the release
shipped. A red `cloudrun` job means production did not move.

**Its secrets are one mounted file, not environment variables.**
`infra/gcp/push-cloudrun-env.sh` (operator) writes the whole runtime set as a
single Secret Manager version, and `scripts/docker-entrypoint.sh` sources it at
boot from the path in `SECRETS_ENV_FILE`. The deploy identity is never granted
`secretAccessor`, so CI can ship an image and cannot read a Stripe key.
`infra/gcp/README.md` is the full account, including why the credential is a
key rather than Workload Identity Federation.

⚠️ **A service whose secret was never written deploys fine and then will not
start.** The preflight cannot catch it — it holds no credential to look with.

⚠️ **The cold start is only acceptable because of a monitor.** HetrixTools
`spiralclass production liveness` hits `/api/health/live` about once a minute,
inside Cloud Run's ~15-minute idle keep, and follows the domain. Do not delete
or re-point it, and keep it on `/api/health/live`: a sub-5-minute check against
`/api/health` holds Neon's compute awake.

### Recovering a release by hand

If Actions cannot run, the operator deploys from the laptop with the same two
scripts the workflow calls, database first because the Cloud Run script holds no
database credential:

```bash
bash scripts/database-deploy.sh production --gate-already-passed
bash scripts/cloudrun-deploy.sh production --gate-already-passed
```

The second one ends by syncing Inngest against the domain.

### Rolling back

**Within Cloud Run:** `gcloud run services update-traffic web --region us-east4
--to-revisions <revision>=100`. That needs the revision's **image** to still
exist, and `config/cloudrun/artifact-cleanup.json` keeps the five newest for
exactly this.

**Off Cloud Run:** there is no warm standby. Fly was destroyed at the cutover
and the Vercel failover was retired ([D-186](../decisions/D-186.md)), so leaving
Cloud Run means standing up a new target and following the section below.

### If the domain ever moves again

The cutover of 2026-09-23 is the template, and these are the steps that cost
something when they were learned. Every one is the operator's.

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
   front ends** — about fifteen minutes on 2026-09-23. Do it outside lesson
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
   keeps a rollback; destroying is a separate decision — taken for Fly on
   2026-09-23, knowing it gave that rollback up.

## Maintenance windows (taking the apps offline)

For planned work that needs the apps offline (a destructive migration, an infra
cutover), flip the **`MAINTENANCE_MODE`** env flag (D-76) — no code deploy
needed to enter or exit. The app serves a localized 503 wall. `/api/health` and
`/api/health/live` stay 200 so the uptime monitors don't flap. (The allowlist once
carried a config route for a client that polled it; client and route are both
gone.)

**Enter:**

1. Set `MAINTENANCE_MODE=1` in **every** environment you're taking down:
   - **Production** → `gcloud run services update web --region us-east4
--update-env-vars MAINTENANCE_MODE=1` (operator-only). That rolls a new
     revision of the same image — no rebuild — and the container environment
     wins over the mounted secret file, so nothing else needs touching.
     ⚠️ `--update-env-vars`, never `--set-env-vars`, which replaces the
     service's whole environment.
   - **Preview** has no host today; once the Oracle box serves it again
     ([D-150](../decisions/D-150.md)), set it there.
   - Optionally set `MAINTENANCE_MESSAGE="…"` and/or `MAINTENANCE_UNTIL="18:00 CST"`
     for custom copy / an ETA, and `MAINTENANCE_BYPASS_TOKEN=<random>` to let
     yourself through.
2. Verify the wall is up — an incognito hit to any page should return the 503
   wall.
3. Do the work.
4. Verify the fix on the **real** site via `https://…/?maintenance_bypass=<token>`
   (sets a cookie so the rest of your session is live while everyone else is walled).

**Exit:** 5. Remove `MAINTENANCE_MODE` everywhere it was set —
`gcloud run services update web --region us-east4 --remove-env-vars
MAINTENANCE_MODE` for production, which rolls another revision. Confirm the app
is live and `/api/health` is green. Remove `MAINTENANCE_MESSAGE`/
`MAINTENANCE_UNTIL`/`MAINTENANCE_BYPASS_TOKEN` the same way if you set them.

> `MAINTENANCE_MODE` is deliberately env-driven, not a DB row: the flag has to be
> readable even when the DB is the thing under maintenance. See D-76.

## One-time setup (manual — do off lesson hours)

### 1. Preview Neon project

- Create a disposable **Neon preview project** (separate from prod).
- Apply schema + seed: put the preview `DATABASE_URL` / `DIRECT_URL` in
  `apps/web/.env.preview.local` (`DIRECT_URL` over the **direct**
  connection, not the pooler — the pooler breaks the seed's prepared statements;
  there is no `SUPABASE_*` env anymore, D-89), then run
  `pnpm --filter spiralclass-web migrate:preview` then
  `pnpm --filter spiralclass-web seed:preview`. (The seed hard-refuses if pointed
  at the production ref, so a mis-set env can't touch prod.)
- The seed has two layers (`apps/web/scripts/seed.ts`): a **deterministic core**
  — Alicia Moreno (the E2E teacher) plus "hero" teachers covering the full
  subscription matrix (Free at-cap, Pro monthly/annual, Founding, trial,
  past-due, canceled) and both payment rails (Stripe-ready + Wise-only) — and
  **optional bulk volume**. For a realistic preview dataset run
  `SEED_BULK_TEACHERS=40 pnpm --filter spiralclass-web seed:preview` (tune the count;
  `SEED_BULK_STUDENTS_PER_TEACHER` defaults to 6). CI seeds the core only.
- **Logging in to preview** (seed accounts can't receive real email): the
  loginable hero teachers use real `profe.*@spiralclass.com` addresses
  (request a magic link at `/sign-in`), and Alicia Moreno + her students use
  `*.test` addresses reachable only via superadmin **impersonation** at
  `/admin` (which reveals the link/code in the UI instead of emailing it).
  Reaching `/admin` requires your own email in `SUPERUSER_EMAILS` (main/preview
  scope) plus MFA.

### 2. Cloud Run production service

- Create a `production` branch at the **current `main` HEAD** (this becomes what
  prod serves — no user-visible change at cutover).
- Production is Cloud Run service `web` in `us-east4`. Its one-time setup — the
  deploy identity, the runtime secret, the image cleanup policy, the budget
  alert — is [`infra/gcp/README.md`](../../infra/gcp/README.md), in that
  order, and the domain mapping is
  [If the domain ever moves again](#if-the-domain-ever-moves-again).
  **Production deploys on a runner** (`deploy-production.yml`, triggered by
  promote's push — D-157). Preview has no host until the Oracle box is rebuilt.
- **Runtime secrets** live in Infisical and reach the service as one mounted
  Secret Manager file, written by `infra/gcp/push-cloudrun-env.sh`, not a
  dashboard. A running revision keeps the version it started with, so a changed
  secret is live only after the next deploy.
  - **prod-vs-preview is decided by `APP_URL`** (there is no `VERCEL_ENV` and no
    `SUPABASE_*` env — D-89); the preview `noindex` header keys off the
    `NEXT_PUBLIC_DEPLOY_ENV` build arg. Preview, when it has a host again, gets
    **sandbox** Stripe/Wise/Meta/Resend keys — never live keys.
  - Note: `NEXT_PUBLIC_*` are build-time; the preview build inlines preview's, the
    production build inlines production's. This is why prod is a rebuild, not an
    artifact-promote (see D-26).
- **Server Action skew**: there is no Cloud Run equivalent of Vercel's Skew Protection.
  The client-side reload fallback (`src/lib/server-action-recovery.ts`) is the
  **sole** mechanism — when a browser running a previous deploy posts a stale
  Server Action ID and hits `Failed to find Server Action "…"`, it reloads to pick
  up the current bundle.

### 3. GitHub

- `pnpm promote` fast-forwards `production` with **your own** git credentials,
  and that push is what triggers the deploy. No token setup is involved: a
  `PROMOTE_TOKEN` PAT existed because a push made with `GITHUB_TOKEN` triggers
  nothing, and this push is made with the operator's own credentials.
- `gh` (authenticated) is still wanted on the machine: it posts the `local-gate`
  commit status and cuts the release tag. Both are REST calls, not workflow
  runs.
- Branch protection on `main` requires the `local-gate` status — see
  `docs/deployment/BRANCH_PROTECTION.md` and re-apply with
  `scripts/setup-branch-protection.sh` after any drift.

### 4. Feature flags

- Dark-launch with `flagEnabled("FLAG_<NAME>")` (`apps/web/src/lib/flags.ts`). Set
  `FLAG_<NAME>=on` in the **main/preview** scope and leave it unset in **Production**;
  flip it on in Production after promotion when you're ready to expose the feature.

## Migrations (live data)

Keep changes **expand/contract** — additive first; drop/rename as a deliberate
two-step release. `heavy.yml`'s integration step applies migrations to a fresh DB on every PR and
every push to `main`, so a broken migration fails before prod.
