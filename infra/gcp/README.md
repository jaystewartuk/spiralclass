# `infra/gcp` — the Cloud Run target's one-time setup

[D-184](../../docs/decisions/D-184.md) added Cloud Run as a third production
target. Every release deploys to it through
[`scripts/cloudrun-deploy.sh`](../../scripts/cloudrun-deploy.sh); **the two
scripts here run rarely and by the operator**, because each of them creates or
writes something a CI job must not be able to.

Not an OpenTofu module, and deliberately so — the same call
[D-139](../../docs/decisions/D-139.md) made about the Oracle box. What these
scripts create is created once, changes almost never, and is easier to read as
prose than as state that drifts from a console nobody remembers using.

| Script                                                   | When                                                       | What it needs                       |
| -------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------- |
| [`setup-deploy-identity.sh`](./setup-deploy-identity.sh) | Once, before the first deploy                              | `gcloud`, Owner on the project      |
| [`push-cloudrun-env.sh`](./push-cloudrun-env.sh)         | Before the first deploy, and after **any** secret rotation | `gcloud`, `infisical login`, `tofu` |

## The identity model, which is the point of this directory

Three identities, and the separation between them is what makes the deploy
safe to run from CI:

- **`web-runtime`** — what the container runs as. It holds **no project role at
  all**: the app reaches Neon, Stripe, LiveKit and R2 over the network and
  needs no Google API. Its one grant is `secretAccessor` on a single secret.
  Not the default Compute Engine service account, which usually carries
  project-wide Editor.
- **`github-deploy`** — what Actions impersonates. It can push an image and
  deploy a revision, and it is **never granted `secretAccessor`**. So the job
  that deploys production genuinely cannot read production's Stripe keys — the
  same boundary [D-163](../../docs/decisions/D-163.md)'s addendum drew when it
  removed the runner's machine identity for Infisical.
- **The operator** — the only identity that can write the secret, under their
  own `infisical login`.

## Why a key, when Workload Identity Federation exists

WIF is the usual advice and was built here first. It was removed, and the reason
is worth keeping because it is not obvious.

WIF needs `id-token: write` on the deploy job. GitHub grants that **per job, not
per step**, so `ACTIONS_ID_TOKEN_REQUEST_URL` sits in front of every step in
that job — and this job builds the Docker image, which means `pnpm install`
running the lifecycle scripts of the whole dependency tree. Anything in there
could mint its own token and trade it for whatever the identity behind it
reaches, however narrow the workflow's own request was.
[D-163](../../docs/decisions/D-163.md)'s addendum reversed exactly that shape
once already, for Infisical, and `apps/web/tests/config/local-gate.test.ts` now
bans `id-token: write` in every workflow in this repository. **A job that runs
third-party install scripts is the worst candidate for an exception, not the
best.**

So the credential is a service-account key for an identity that can deploy a
revision and cannot read a secret — the same trade `FLY_API_TOKEN` and
`VERCEL_TOKEN` already make, with the same blast radius.

**The cost is rotation, and nothing automates it.** The key is long-lived, and
`setup-deploy-identity.sh` deliberately does not mint, print or write one — it
prints the command, so the only copy that exists is the one piped into the
vault.

## The two values CI needs

They belong in Infisical `production` at `/deploy`, beside `FLY_API_TOKEN` and
the `VERCEL_*` values, and reach the workflow through the same sync
([D-163](../../docs/decisions/D-163.md)) — never typed into GitHub by hand.

| Name             | What it is                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `GCP_PROJECT_ID` | The project. An **account identifier**, so it is not in this tree — [D-158](../../docs/decisions/D-158.md) |
| `GCP_DEPLOY_KEY` | `github-deploy`'s key, the whole JSON document                                                             |

Unset `GCP_DEPLOY_KEY` locally and `scripts/cloudrun-deploy.sh` falls back to
the operator's own `gcloud auth login` — the same split `scripts/fly-deploy.sh`
makes between the runner and the laptop.

## Why the secrets are one file, not eighteen variables

`push-cloudrun-env.sh` writes **one** Secret Manager secret
(`web-runtime-env`) holding the whole runtime set as an env-file, and
`scripts/cloudrun-deploy.sh` mounts it at `/secrets/runtime.env`.
`scripts/docker-entrypoint.sh` sources it when `SECRETS_ENV_FILE` names it, and
skips the whole block when it does not — which is why **Fly's boot is
unchanged**.

Three reasons, in the order they decided it:

1. **Cost.** Secret Manager's free tier is six active versions and this app has
   ~18 secrets. Eighteen secrets would be 12 × $0.06 = **$0.72/month** against a
   migration whose entire prize is ~$7/month. One version is free, and reading
   it a few hundred times a month is far inside the 10,000 free access
   operations. (Prices read 2026-09-21; Google's pricing page carries no
   "last updated" stamp, so re-check before relying on it.)
2. **The credential boundary.** A mounted secret is named, not valued, in the
   deploy command — so the deploy identity needs no read access to it.
   `--set-env-vars` would have required CI to hold every value.
3. **[D-66](../../docs/decisions/D-66.md).** `gcloud`'s env-var flags take
   values as **process arguments**, where `ps` can read them. The secret's
   content goes in over stdin and never appears in argv.

The cost is real and worth naming: **rotating one value rewrites the whole
blob.** That is what re-running this script does, and it is what
`push-fly-secrets.sh` effectively does on Fly too.

## The two ways this target stops being free

Neither is the steady state. At this traffic the compute grant is barely
touched — the once-a-minute liveness monitor is the dominant consumer, at
roughly a tenth of it, and real visitors are a rounding error on top. What bills
is an unusual month, or time.

**Stored images, which is the one that will actually happen.** Artifact
Registry's free allowance is 0.5 GB and every release pushes another image
(~112 MB listed, less once layers dedupe). Nothing prunes them, so a normal
release cadence crosses the line in a few weeks and then charges a few cents a
month, forever, for images no deploy will pull again.
[`config/cloudrun/artifact-cleanup.json`](../../config/cloudrun/artifact-cleanup.json)
is the policy `setup-deploy-identity.sh` applies:

| Rule                   | What it does                                                  |
| ---------------------- | ------------------------------------------------------------- |
| `keep-recent-releases` | Keeps the 5 newest versions, whatever else says               |
| `delete-untagged`      | Drops build leftovers after a day                             |
| `delete-superseded`    | Drops anything older than 60 days that the first did not keep |

Keep rules win over delete rules, so the newest five survive both.

**Why five, and why that number is a guess.** A Cloud Run rollback re-points at
an earlier revision, and that revision needs its image to still exist — so the
count is a rollback depth, not a storage tuning. Five is about two days of
rollback at the current cadence. The storage arithmetic behind it assumes layer
deduplication brings the marginal image well under its listed size, which is
**not measured**. Check `gcloud artifacts repositories describe spiralclass
--location us-east4 --format='value(sizeBytes)'` after a few releases; if it is
climbing toward 500 MB, lower the count rather than paying for depth nobody
uses.

**Spend, which is the tail risk.** Cloud Run has **no hard spending cap**.
`MAX_INSTANCES` in `config/cloudrun/production.env` bounds how fast a crawl, a
loop or an attack can spend — at a few hundred dollars a month, not at zero. A
cap that stopped the service would trade a bill for an outage on a payments
platform, which is the wrong trade, so the mitigation is a **budget alert** set
low enough to mean something: $5, because the point of this target is $0 and a
five-dollar bill means something is wrong rather than that the service got
popular. `setup-deploy-identity.sh` lists existing budgets and prints the
command to create one — a budget lives on the billing account, not the project,
and needs a role there that project Owner does not imply.

## The first deploy will not tell you it is missing

A service whose secret has never been written **deploys successfully** and then
fails to start: the entrypoint exits on a missing mount and Cloud Run reports a
container that would not come up. `scripts/cloudrun-deploy.sh`'s preflight
cannot catch this — it holds no credential to look with, by design.

So the order is: `setup-deploy-identity.sh`, then `push-cloudrun-env.sh`, then
the first deploy, and **verify the `run.app` URL by hand** before anything else
depends on it.

## What this directory does not do

**It never maps a domain.** `spiralclass.com` is Fly's until the operator moves
it, and no script here or in `scripts/` can move it. The cutover — map the
domain, move the Inngest registration off Fly, watch a real class join, then
stop the Fly app — is in `docs/deployment/RELEASE_AND_STAGING.md` and is the
whole point of the target existing.
