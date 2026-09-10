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

⚠️ **PREVIEW's deploy workflow is suspended; production's is not** (D-157's
addenda). Production stays on Fly and `deploy-production.yml`'s `push` trigger
is live — `pnpm promote` reads that trigger off the workflow file and refuses
before the fast-forward if it is ever missing. Preview moves to the Oracle A1
box ([D-150](../decisions/D-150.md)) and has `workflow_dispatch` alone until
that box is serving, so merging to `main` does not deploy preview today; run
`pnpm ship:preview`. `./scripts/fly-deploy.sh <env>` still deploys from the
laptop and is the recovery path.

This file is the operator runbook — the one-time setup, the everyday release
flow, and rollback.

## Everyday release flow

1. Branch, commit, `git push` — the pre-push hook runs the fast gate on your
   machine and posts the `local-gate` status once the push lands (D-119). Open a
   PR into `main`; when that status is green on the PR head, branch protection
   unlocks the merge button. (No laptop? **`gate.yml` posts the same context on
   the PR** — D-157 — so the PR is not stranded. Say plainly which run you saw,
   and never imply you posted a status you did not.) Merge, then ship preview
   yourself while preview's workflow is suspended:

   ```sh
   pnpm ship:preview   # when this commit changed something preview carries
   ```

   It migrates the preview DB and deploys `preview.spiralclass.com`. A docs- or
   test-only commit ships nothing. Do this before any manual pass — it runs
   against the _deployed_ preview, and a stale one reads as flakiness.
   `--gate` runs the full tier first.

2. _(Optional)_ Run **`pnpm gate:full`** on `main` — fast tier + mutation +
   integration + E2E, and it **deploys nothing**. The gate is hermetic: it
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
5. The workflow, after a **required reviewer**, runs the same
   `scripts/fly-deploy.sh production` the operator runs by hand: checkpoint the
   Neon `production` branch → migrations → **native amd64** image → `flyctl
deploy` → Inngest sync → the **production probes** against the live site.
   `pnpm promote` watches that run and exits non-zero if it goes red, so a green
   promote means production is serving.
   - If the deploy fails _after_ the fast-forward, the branch moved and the app
     did not. Re-run the workflow, or
     `./scripts/fly-deploy.sh production --gate-already-passed` from here — the
     same script either way.
6. `pnpm release:status` for what this machine has and hasn't shipped, and
   `pnpm local:status` for whether the probes and the sweep are current.

## Rollback

**Code:** `flyctl releases -a agendaprofe` to see recent releases, then
`flyctl deploy -a agendaprofe --image <previous>` (or `fly releases rollback`)
to redeploy a known-good image, then `git revert` on `main` when fixed. Do
**not**
fast-forward `production` backwards; roll forward to a new commit or redeploy
a previous image instead.

**Captions Agent (self-hosted Oracle box):** not covered by any of the above —
it does not ship through Fly or `pnpm promote`. Its images are built on the box
and tagged `spiralclass-captions-agent:<sha>`, so rollback is repointing the
pinned tag in `~/oracle-livekit-production/docker-compose.yml` and
`docker compose up -d --no-build captions-agent` — no rebuild, no network.
**Check the live-call interlock first**: restarting the Agent kills captions
for any class in progress. Full procedure in
[`ORACLE_LIVEKIT_PRODUCTION.md`](./ORACLE_LIVEKIT_PRODUCTION.md)
§"Captions Agent — deploy & rollback".

**This only rolls back code, never the database.** A code rollback does not
undo a migration or bad data change. `scripts/fly-deploy.sh` checkpoints the
Neon `production` branch before every production migration (D-95) —
restore it in seconds with `infra/database/scripts/neon-rollback.sh`, Neon's
own point-in-time restore. See [`DB_BACKUP_RESTORE.md`](./DB_BACKUP_RESTORE.md) for the full
restore procedure and the fastest safe recovery path for a failed migration.

## The Vercel failover ([D-175](../decisions/D-175.md))

**Production serves from Fly. This does not change that**, and nothing in CI can.

Every production release also deploys the same commit to Vercel, as a second job
in `deploy-production.yml` that runs **after** the Fly deploy and its probes. That
deployment is built, live, and **holds no domain** — `vercel deploy --prebuilt
--prod --skip-domain`. It exists so the failover is proven on every release
rather than being a project nobody has deployed since they set it up ([D-164](../decisions/D-164.md)
is the lesson).

A red `vercel` job means **the failover did not refresh**. Production is
unaffected; read the job above it, which is the one that shipped.

**To hand it the domain.** This is the one command that makes Vercel serve
traffic, and it is an operator step — a session is blocked from running it by
`.claude/hooks/guard-bash.sh`:

```sh
vercel promote <deployment-url> --yes
```

No CLI version is written here on purpose: `scripts/vercel-deploy.sh` holds the
one pin, and its final line prints this command with that version and the real
deployment URL already filled in. Copy it from the deploy's output rather than
from here, and a bumped pin cannot leave a stale number in a runbook.

⚠️ **Read this before you do it in an incident. It is not yet a complete
failover:**

- **Inngest still points at Fly.** The endpoint is registered per URL and the
  Vercel deploy deliberately does not sync it (syncing a second URL would fire
  every cron twice — see D-175). After a promote, **background work is pointed at
  an app that is no longer serving**: reminders, emails and push notifications.
  Sync it by hand at the new URL, and know that Fly's registration must go.
- **The region pin is unverified.** `config/vercel/production.json` says `cle1`
  on the strength of D-150's "Neon is in Ohio". Confirm with
  `neonctl projects list`; a wrong region costs the 58-ms-versus-12-ms hop that
  record measured, on every query.
- **Nothing has ever served a request from it.** Cold-start behaviour against
  Neon is unmeasured.

To hand it back, `vercel rollback`, or point DNS at Fly — whichever is faster at
the time.

To refresh it by hand without a release, `pnpm deploy:vercel` (operator-only, and
it refuses production without `--yes-i-understand-this-skips-the-promote-gate`).

## Changing the Fly region (one-time, manual)

**Editing `primary_region` in a fly config does NOT relocate machines that
already exist.** `fly deploy` reuses the machines in place; `primary_region`
only decides where _newly created_ machines land. So a region change that
stops at the config edit is a silent no-op — the config claims `ord`, the
machines keep running in `dfw`, and nothing warns you.

Both apps moved `dfw` → `ord` to sit next to Neon's `aws-us-east-2` (see the
comment at the top of `fly.production.toml` for why). To actually land that on
an existing app, per app (`agendaprofe`, `agendaprofe-preview`):

```bash
fly status -a agendaprofe                      # note the current machine ids + count
fly machine clone <machine-id> --region ord -a agendaprofe   # repeat per machine
fly status -a agendaprofe                      # confirm the ord machines are healthy
fly machine destroy <old-dfw-machine-id> -a agendaprofe --force
```

Clone-then-destroy rather than destroy-then-create: production runs
`min_machines_running = 2` precisely so there is no single point of failure,
and destroying first would drop to one machine (or zero) mid-move. Do
**preview first**, confirm it is healthy, and do production off lesson hours.

Verify the move actually paid off before closing it out — the whole point is
the round trip to Neon. In Sentry, the `BEGIN` span on any DB-touching
transaction is pure RTT (the statement does no work), so it is the cleanest
probe available: it averaged **27.5ms** from `dfw` and should land in the
single digits from `ord`. If it did not move, the machines did not move.

## Maintenance windows (taking the apps offline)

For planned work that needs the apps offline (a destructive migration, an infra
cutover), flip the **`MAINTENANCE_MODE`** env flag (D-76) — no code deploy
needed to enter or exit. The app serves a localized 503 wall. `/api/health` and
`/api/health/live` stay 200 so Fly + monitors don't flap. (The allowlist once
carried a config route for a client that polled it; client and route are both
gone.)

**Enter:**

1. Set `MAINTENANCE_MODE=1` in **every** environment you're taking down:
   - **Production** → `fly secrets set MAINTENANCE_MODE=1 -a agendaprofe`
     (hot-applies on restart — no rebuild needed) or `fly.production.toml`
     `[env]` + redeploy.
   - **Preview** → `fly secrets set MAINTENANCE_MODE=1 -a agendaprofe-preview`
     (hot-applies on restart), or `fly.preview.toml` `[env]`.
   - Optionally set `MAINTENANCE_MESSAGE="…"` and/or `MAINTENANCE_UNTIL="18:00 CST"`
     for custom copy / an ETA, and `MAINTENANCE_BYPASS_TOKEN=<random>` to let
     yourself through.
2. Verify the wall is up — an incognito hit to any page should return the 503
   wall.
3. Do the work.
4. Verify the fix on the **real** site via `https://…/?maintenance_bypass=<token>`
   (sets a cookie so the rest of your session is live while everyone else is walled).

**Exit:** 5. Unset `MAINTENANCE_MODE` (or set `0`) everywhere it was set —
`fly secrets unset MAINTENANCE_MODE -a agendaprofe` (and `-a
   agendaprofe-preview`), which restarts the machines to apply, or redeploy if
you set it via `fly.toml`. Confirm the apps are live and `/api/health` is
green. Clear `MAINTENANCE_MESSAGE`/`MAINTENANCE_UNTIL` if you set them.

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

### 2. Fly production app

- Create a `production` branch at the **current `main` HEAD** (this becomes what
  prod serves — no user-visible change at cutover).
- Production is the Fly app `agendaprofe`; preview is the Fly app
  `agendaprofe-preview`. **Production deploys on a runner**
  (`deploy-production.yml`, triggered by promote's push — D-157); preview
  deploys from this machine via `pnpm ship:preview` while its own workflow is
  suspended.
- **Environment / secrets** live in **Fly secrets** (`fly secrets set/list/unset
-a <app>`, fed from Infisical), not a Vercel dashboard, and they hot-apply on
  machine restart (no rebuild needed):
  - Set prod values on the `agendaprofe` app; set the preview values on
    `agendaprofe-preview`, including `DATABASE_URL`, `DIRECT_URL`, `SESSION_SECRET`,
    `APP_URL` (= `https://preview.spiralclass.com`), plus **sandbox**
    Stripe/Wise/Meta/Resend keys (never live keys on preview).
  - **prod-vs-preview is decided by `APP_URL`** (there is no `VERCEL_ENV` and no
    `SUPABASE_*` env — D-89); the preview `noindex` header keys off the
    `NEXT_PUBLIC_DEPLOY_ENV` build arg.
  - Note: `NEXT_PUBLIC_*` are build-time; the preview build inlines preview's, the
    production build inlines production's. This is why prod is a rebuild, not an
    artifact-promote (see D-26).
- Domains: point **`preview.spiralclass.com` → `agendaprofe-preview`**; keep
  `spiralclass.com` on the production app.
- **Server Action skew**: there is no Fly equivalent of Vercel's Skew Protection.
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
two-step release. Preview migrates on every `pnpm ship:preview`, and
`heavy.yml`'s integration step applies migrations to a fresh DB on every PR and
every push to `main`, so a broken migration fails before prod.
