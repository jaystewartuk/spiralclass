# Running this repo from the laptop

**Nothing in this repo is scheduled anywhere.** [D-129](../decisions/D-129.md)
deleted every workflow and every composite action — the deploy, the gate
fallbacks, and the three crons — because a private repo's backup should not
depend on a metered allowance: when the month's minutes ran out, every private
workflow started failing at once, and production's Postgres went eleven days
without a backup while the public repos stayed green.

[D-157](../decisions/D-157.md) brought the workflows back once the repository
went public and the minutes became free, and
[D-161](../decisions/D-161.md)/[D-162](../decisions/D-162.md) moved the heavy
suites onto runners too. There is still deliberately **no `schedule:`
trigger**, so the maintenance jobs below are commands you run, and the
mechanism that makes "nobody ran it" visible is still the nag at the end of
`pnpm gate`.

⚠️ **The production probes are the exception.** They run as the last step of
`deploy-production.yml`, at the moment a deploy could have broken something —
and `pnpm promote` records that success locally, so the staleness clock below
clears on a deploy rather than nagging about a job that just ran.

What that still costs, up front: **a shut laptop backs up nothing**. D-129
states that plainly, and it is the one gap the runners did not close.

## The whole workflow

Four commands, in order. Everything below this section is detail on one of them.

```sh
git push                 # 1. the gate runs itself (pre-push hook), PR, merge
pnpm ship:preview        # 2. preview, when you want it fresh right now
                         # 3. test it — the manual pass
pnpm promote             # 4. production: certify, fast-forward, watch the deploy
pnpm release:status      #    what is live vs what is merged
```

Plus one more, on no schedule at all — see [Maintenance](#maintenance-nothing-runs-these-but-you):

```sh
pnpm local:status        # when did the probes and the sweep last pass?
```

1. **Push and merge.** `.githooks/pre-push` runs `pnpm gate` (fast tier) and
   posts the `local-gate` status branch protection requires. `gate.yml` posts
   the same context on the PR, so a laptop-less day is not a stranded PR.
   `heavy.yml` runs the mutation, integration and browser suites on every PR
   and on every push to `main`.
2. **`pnpm ship:preview`** ships preview web (migrations → image → Fly →
   Inngest) when this commit changed something preview carries. It compares the
   commit against what this machine last shipped (`scripts/ci/relevance.mjs` +
   the ledger), so a commit that cannot have moved preview does not spend a
   build. `--force` ships regardless; `--gate` runs the full tier first.
3. **Test on preview.** The U80 manual pass. `pnpm gate --allow-dirty` answers
   "is this clean?" mid-work without deploying anything.
4. **`pnpm promote`**, outside lesson hours. It **reads the runners' verdict**
   for this exact commit (Gate and Heavy, both green for the SHA) → confirm →
   fast-forward `production` + release tag → **that push triggers
   `deploy-production.yml`**, which after a required reviewer runs
   `scripts/fly-deploy.sh production` on a runner — Neon checkpoint →
   migrations → native amd64 image → Fly deploy → Inngest sync → **production
   probes**. `promote` watches that run and exits non-zero if it goes red.

## What runs where

| Job                                                   | Where                                             | How                                                               |
| ----------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| Merge gate (format · typecheck · lint · unit · audit) | Laptop, every push · **and** a runner, every PR   | `.githooks/pre-push` → `pnpm gate` (D-119) · `gate.yml` (D-157)   |
| Heavy tier (mutation · integration · E2E · visual)    | Runner, every PR and every push to `main`         | `heavy.yml` (D-161)                                               |
| **Production deploy**                                 | Runner, triggered by promote's push               | `deploy-production.yml` → `scripts/fly-deploy.sh` (D-157)         |
| Preview deploy                                        | Laptop, on demand                                 | `pnpm ship:preview` / `pnpm deploy:preview`                       |
| Production synthetic probes                           | Runner, after every production deploy; on demand  | last step of `deploy-production.yml` · `pnpm local synthetic`     |
| Production DB backup                                  | **Neon** (PITR + pre-migration checkpoints, D-95) | not a local job — see the [D-129](../decisions/D-129.md) addendum |
| Time-bomb sweep                                       | Laptop, on demand                                 | `pnpm local sweep`                                                |

**There is still no scheduler**, and no cron either. A launchd agent was
considered and not built: it is a schedule nobody owns, and a shut laptop
misses it exactly as thoroughly as it misses everything else. What replaced the
cron is a receipt and a nag — see the next section.

## Maintenance: nothing runs these but you

Three jobs used to run on a GitHub Actions cron. They are commands now, and no
clock will ever start them:

```sh
pnpm local synthetic     # probe production: every public surface, body-marked
pnpm local sweep         # unit suites + audit, against today's date
pnpm local:status        # when each last SUCCEEDED, and what is overdue
```

**There is deliberately no `pnpm local backup`** (D-129 addendum, 2026-08-25):
**Neon backs production up**, and a hand-run pg_dump on top of that is not a
routine. `scripts/local/backup-prod-db.sh` survives as an on-demand tool for the
one thing Neon cannot give you — a copy living outside Neon entirely — and is
not in the registry, so nothing nags about it. Run it by hand before a migration
risky enough to want that copy. What this gives up is in the addendum.

**The thing to understand about this arrangement is that the risk is not
forgetting — it is not knowing you forgot.** A job nobody ran looks exactly
like a job that ran fine. So:

- Every run writes a receipt to `.gate/local-jobs.json` (gitignored, local to
  this machine), keeping the last run and the last _successful_ run separately,
  so a week of failures never reads as fresh.
- **`pnpm gate` prints one line per overdue job**, and the pre-push hook runs
  the gate on every push — so the report arrives while you are at the keyboard,
  not in an inbox you are not reading. It never fails the gate: a stale job is
  not a reason to reject a commit.
- A failed run alerts twice: **ntfy to the phone** (for "started it and walked
  away") and a **macOS notification** (for "it scrolled off in a tab"). Both
  fail open — the alerting must never be what fails the job.

Budgets are seven days each, which is a nag interval rather than a cadence. A
banner that fires daily is a banner nobody reads.

The probes are the exception to "by hand": **`deploy-production.yml` runs them
itself** once production is serving the new code, because a deploy is when the
regressions they catch get introduced. `pnpm promote` records the receipt when
that run goes green, so the nag's clock clears on a deploy.

**If you ever do reach for `scripts/local/backup-prod-db.sh`**, five secrets have
to be in Infisical's `production` environment first: `PROD_BACKUP_DB_URL`,
`R2_BACKUP_BUCKET`, `R2_BACKUP_ENDPOINT`, `R2_BACKUP_ACCESS_KEY`,
`R2_BACKUP_SECRET` (plus `NTFY_URL` / `NTFY_TOPIC` for the phone alert). They
were GitHub repo secrets, and nothing reads those any more. The script reads the
environment first and falls back to Infisical, and **fails closed** if any is
missing. It also needs `libpq` (`brew install libpq`, for a `pg_dump` at least
as new as the server) and `awscli`. **None of that has been set up**, because
the job is not a practice — treat the first run as a setup exercise.

## Deploying production

```sh
pnpm promote
```

One command. It **reads the runners' verdict** for this exact commit rather
than running the suites here ([D-162](../decisions/D-162.md)) — Gate and Heavy
must both be green for the SHA — then fast-forwards `production` and cuts the
release tag. **That push is the trigger**: `deploy-production.yml` runs, and
after a required reviewer does Neon checkpoint → migrations → amd64 image → Fly
deploy → Inngest sync → **production probes**. `promote` watches the run and
exits non-zero if it goes red, so a green promote means production is serving.

The deploy is chained to the push on purpose. What left `production` 96 commits
behind live on 2026-07-19 was a human dispatch step; a deploy you have to
remember is that incident waiting to repeat. Moving the build to a runner did
not reintroduce it — the push at the end of `promote` IS the trigger, and a
pending reviewer approval is visible (a queued run in the Actions tab, and
`pnpm release:status` still red) in a way a forgotten dispatch never was.

> ⚡ **The image builds on a native amd64 runner**, not here. On this arm64
> laptop it was a 20-30+ minute QEMU cross-build, which made a promote
> something you scheduled rather than something you did.

Flags worth knowing:

- **`--force-gate`** — run the full tier HERE instead of reading the runners.
  The answer when a commit has aged out of what GitHub still keeps: an expired
  workflow run is not a green one, and `promote` refuses rather than guessing.
- **`--no-wait`** — stop once `production` is fast-forwarded. `--no-deploy` is
  the old spelling and now means this; it **cannot** suppress the deploy, since
  the push is the trigger.
- **`--mobile` / `--no-mobile`** — accepted and inert, so an old habit or
  runbook does not die on an unknown flag. There is no mobile half.

If the deploy fails _after_ the fast-forward, the branch has moved and the app
has not. Re-run the workflow, or deploy from here — the same script either way:

```sh
./scripts/fly-deploy.sh production --gate-already-passed
```

## Deploying preview

```sh
pnpm ship:preview                 # when this commit changed something preview carries
pnpm ship:preview --force         # regardless
pnpm ship:preview --gate          # full tier first
pnpm deploy:preview               # the raw web deploy, no decisions
```

⚠️ **`deploy-preview.yml` is suspended** — preview moves to the Oracle A1 box
([D-150](../decisions/D-150.md)), and the workflow has `workflow_dispatch`
alone until that box is serving. So merging to `main` does not deploy preview
today, and `pnpm ship:preview` is what you run when you want preview fresh
right now. Hand-testing against a stale preview reads as a product bug.

It skips a deploy only when it can prove nothing relevant changed since the last
time **this machine** shipped. No ledger record means ship; an unrecognised path
counts as relevant. The failure direction is a redundant deploy, never a silent
no-op.

## What is live

```sh
pnpm release:status
```

Compares what this machine shipped (`.gate/release.json`, written by every ship
path) against `origin/main` and `origin/production`, and exits 1 when something
is behind. It knows only what THIS machine did, so an Actions deploy shows as
"no local record" rather than "did not ship".

## What a dead laptop still costs

D-129 left no fallback of any kind. [D-157](../decisions/D-157.md) and
[D-161](../decisions/D-161.md) recovered most of it — a PR gets its
`local-gate` status from `gate.yml`, the heavy suites run on runners, and both
deploys run on runners. What is left:

- **A shut laptop backs up nothing.** Neon's PITR is the answer, and the gap it
  accepts is in the D-129 addendum.
- **A cloud session cannot post a status itself** — but it does not need to;
  `gate.yml` posts one for the PR. Say plainly which run you saw, and never
  imply you posted a status you did not.

Re-adding a workflow that restates a check (rather than calling
`scripts/ci/gate.mjs` or `scripts/fly-deploy.sh`) fails
`apps/web/tests/config/local-gate.test.ts`, on purpose.

## If a hosted dependency has to come back

It already did, on one condition: **a workflow CALLS the registry or the deploy
script and never restates what they do.** If the repository ever goes private
again, the reversal is deleting `.github/workflows/` and nothing else —
[D-157](../decisions/D-157.md) is written to keep that true. See
[`COST_PLAYBOOK.md`](COST_PLAYBOOK.md) and [D-129](../decisions/D-129.md).
