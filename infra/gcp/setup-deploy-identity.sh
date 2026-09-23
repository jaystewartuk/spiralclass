#!/usr/bin/env bash
# One-time: create the two service accounts and the keyless path GitHub Actions
# uses to become one of them ([D-184]). Run by the OPERATOR, with Owner on the
# project. Idempotent — every step tolerates already existing, so re-running it
# after a partial failure is safe and is the intended recovery.
#
#   infra/gcp/setup-deploy-identity.sh <project-id>
#
# It prints the three values CI needs at the end. They go into Infisical
# `production` at /deploy, and reach the workflow through
# the Infisical sync ([D-163]) — never typed into GitHub by hand.
#
# ⚠️ IT GRANTS NO `secretAccessor` TO THE DEPLOY ACCOUNT, and that omission is
# the point of the file. github-deploy can push an image and roll a revision; it
# cannot read the secret that revision mounts. Only web-runtime can. If a future
# change adds that grant "to debug something", it has quietly handed every step
# of a CI job — `pnpm install` included — the production Stripe keys.
#
# ⚠️ IT CREATES A SERVICE ACCOUNT KEY, which is the opposite of the usual
# advice, and the reversal is the interesting part of this file.
#
# Workload Identity Federation was built here first and removed. It needs
# `id-token: write` on the deploy job; GitHub grants that per JOB rather than
# per step; and that job builds the Docker image — so every lifecycle script in
# the dependency tree would run with a token-minting endpoint in front of it.
# [D-163]'s addendum reversed that exact shape once already, and
# apps/web/tests/config/local-gate.test.ts bans it in every workflow in this
# repository. A job that runs `pnpm install` is the worst candidate for an
# exception, not the best.
#
# So the credential is a key for an identity that can deploy a revision and
# cannot read a secret — the same trade Fly's token made. Its real cost is rotation, which nothing automates:
#
#   gcloud iam service-accounts keys list  --iam-account=<deploy sa>
#   gcloud iam service-accounts keys create - --iam-account=<deploy sa>  # stdout
#   …put it in Infisical production /deploy as GCP_DEPLOY_KEY, then…
#   gcloud iam service-accounts keys delete <old-id> --iam-account=<deploy sa>
set -euo pipefail

GCP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$GCP_DIR/../.." && pwd)"

PROJECT="${1:-}"
if [ -z "$PROJECT" ]; then
  echo "usage: infra/gcp/setup-deploy-identity.sh <project-id>" >&2
  echo "" >&2
  echo "The project id is an account identifier and is deliberately not in this" >&2
  echo "tree (D-158) — pass it, or read it from Infisical production /deploy as" >&2
  echo "GCP_PROJECT_ID." >&2
  exit 1
fi

# Read from config/cloudrun/production.env rather than retyped: that file is
# what the deploy reads, and a second spelling of the region or the repository
# name here is the copy that stops matching it.
SHAPE="$REPO_ROOT/config/cloudrun/production.env"
[ -f "$SHAPE" ] || { echo "missing $SHAPE" >&2; exit 1; }
# shellcheck disable=SC1090
set -a && . "$SHAPE" && set +a

RUNTIME_SA="$RUNTIME_SA_ID@$PROJECT.iam.gserviceaccount.com"
DEPLOY_SA="github-deploy@$PROJECT.iam.gserviceaccount.com"

command -v gcloud >/dev/null || { echo "install the Google Cloud CLI" >&2; exit 1; }

# `|| true` on creates only — a create that fails because the thing exists is
# this script being re-run, which is supported. A BINDING that fails is not
# swallowed, because a missing grant is how this ends up half-configured.
say() { printf '\n› %s\n' "$*"; }

say "APIs"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project "$PROJECT"

say "Artifact Registry repository ($REGION)"
gcloud artifacts repositories create "$ARTIFACT_REPO" \
  --repository-format=docker --location="$REGION" \
  --description="SpiralClass web image (D-184)" \
  --project "$PROJECT" 2>/dev/null || echo "  already exists"

# ⚠️ THE MOST LIKELY FIRST BILL ON THIS WHOLE TARGET, and the quietest.
# Artifact Registry's free allowance is 0.5 GB and each release pushes another
# image. Nothing prunes them, so the repository grows on a normal release
# cadence until it crosses the line and starts charging — a few cents, forever,
# for images no deploy will ever pull again.
#
# NOT a delete-everything-old rule: a Cloud Run rollback re-points at a previous
# revision, which needs that revision's IMAGE to still exist. The policy keeps
# the most recent handful for exactly that, and the count is a judgement about
# how far back a rollback is plausible — see infra/gcp/README.md, which also
# says why that number is a guess worth re-checking.
say "Image retention policy"
gcloud artifacts repositories set-cleanup-policies "$ARTIFACT_REPO" \
  --location="$REGION" --project "$PROJECT" \
  --policy="$REPO_ROOT/config/cloudrun/artifact-cleanup.json" \
  --no-dry-run

say "Runtime identity ($RUNTIME_SA_ID) — holds NO project role"
# ⚠️ $RUNTIME_SA_ID, never the literal name. Everything below binds roles to
# "$RUNTIME_SA_ID@…", so a literal here that stopped matching the config would
# create one account and grant the other — leaving the service deployable and
# unable to read its own secret, which surfaces as a container that will not
# start rather than as anything naming the cause.
gcloud iam service-accounts create "$RUNTIME_SA_ID" \
  --display-name="SpiralClass web runtime (Cloud Run)" \
  --project "$PROJECT" 2>/dev/null || echo "  already exists"

say "Deploy identity — GitHub Actions impersonates this"
gcloud iam service-accounts create github-deploy \
  --display-name="GitHub Actions: build and deploy the web service" \
  --project "$PROJECT" 2>/dev/null || echo "  already exists"

say "The secret itself, empty for now — push-cloudrun-env.sh writes the version"
gcloud secrets create "$SECRET_NAME" \
  --replication-policy=automatic \
  --project "$PROJECT" 2>/dev/null || echo "  already exists"

say "Only the runtime identity may read it"
gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  --member="serviceAccount:$RUNTIME_SA" \
  --role=roles/secretmanager.secretAccessor \
  --project "$PROJECT" --condition=None --format=none

say "What the deploy identity may do — note what is absent"
for role in roles/run.admin roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$DEPLOY_SA" --role="$role" \
    --condition=None --format=none
done
# Needed to deploy a revision that RUNS AS web-runtime. Scoped to that one
# account rather than granted project-wide, so github-deploy cannot act as any
# other identity in the project.
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:$DEPLOY_SA" \
  --role=roles/iam.serviceAccountUser \
  --project "$PROJECT" --format=none

say "Existing keys on the deploy account"
# Listed rather than counted for the reader: a key nobody remembers creating is
# worth seeing, and this script must not delete one it did not make.
#
# ⚠️ ALSO counted, because what follows depends on it. This script is meant to be
# re-run — it is the recovery path for a partial failure — and the first version
# printed "mint a key" unconditionally at the end of every run, including runs
# where the key it was asking for already existed and was in use by CI. An
# operator following that advice ends up with two valid keys and no way to tell
# which one to revoke, which is a worse position than the one they started in.
gcloud iam service-accounts keys list --iam-account="$DEPLOY_SA" \
  --managed-by=user --project "$PROJECT" --format='table(name.basename(),validAfterTime)' ||
  echo "  none"
EXISTING_KEYS="$(
  gcloud iam service-accounts keys list --iam-account="$DEPLOY_SA" \
    --managed-by=user --project "$PROJECT" --format='value(name)' 2>/dev/null | grep -c . || true
)"

# ── The spend alert, which this script can only ask for ────────────────────
#
# Cloud Run has NO HARD SPENDING CAP. `--max-instances` bounds how fast a crawl,
# a loop or an attack can spend, and bounds it at a few hundred dollars a month
# rather than at zero. A cap that stopped the service would trade a bill for an
# outage on a payments platform, which is the wrong trade — so the mitigation is
# an alert that arrives early, not a switch that cuts traffic.
#
# A budget lives on the BILLING ACCOUNT, not the project, and creating one needs
# a role on that billing account which Owner on the project does not imply. So
# this prints the command rather than failing halfway through on a permission
# the operator may have to grant themselves first.
BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' 2>/dev/null || true)"
EXISTING_BUDGETS=0
if [ -n "$BILLING" ]; then
  say "Existing budgets on ${BILLING}"
  gcloud billing budgets list --billing-account="${BILLING#billingAccounts/}" \
    --format='table(displayName,amount.specifiedAmount.units)' 2>/dev/null ||
    echo "  could not list — needs roles/billing.viewer on the billing account"
  EXISTING_BUDGETS="$(
    gcloud billing budgets list --billing-account="${BILLING#billingAccounts/}" \
      --format='value(name)' 2>/dev/null | grep -c . || true
  )"
fi

# Asked for only when there is none. The first version printed this behind the
# words "if no budget is listed above" — which is a reader's job the script can
# do itself, and which reads as an instruction on a run where the answer is
# already no.
if [ "$EXISTING_BUDGETS" = "0" ]; then
  cat <<EOF

────────────────────────────────────────────────────────────────────────
No budget on this billing account. Cloud Run cannot be capped, so an
alert is the only thing between an unusual month and a surprise:

  gcloud billing budgets create \\
    --billing-account=${BILLING#billingAccounts/} \\
    --display-name="spiralclass — alert, not a cap" \\
    --budget-amount=5USD \\
    --threshold-rule=percent=0.5 --threshold-rule=percent=1.0

\$5 because the whole point of this target is \$0: a bill of five dollars
means something is wrong, not that the service got popular.
────────────────────────────────────────────────────────────────────────
EOF
fi

cat <<EOF

────────────────────────────────────────────────────────────────────────
Identities and grants are in place.
────────────────────────────────────────────────────────────────────────
EOF

if [ "$EXISTING_KEYS" = "0" ]; then
  cat <<EOF
Two values go into Infisical \`production\` at /deploy. Do not type them
into GitHub by hand — the sync (D-163)
is what puts them in the environment.

  GCP_PROJECT_ID = $PROJECT
  GCP_DEPLOY_KEY = the JSON from the command below, whole

Mint the key yourself, so its only copy goes where you put it — this
script deliberately does not create one, print one, or write one to disk:

  gcloud iam service-accounts keys create - \\
    --iam-account=$DEPLOY_SA --project=$PROJECT

\`-\` writes to stdout. Pipe it straight into the vault; never leave it
in a file, and never let it reach a shell history.

THEN, and the deploy will not warn you if you skip it:

  infra/gcp/push-cloudrun-env.sh $PROJECT

A service whose secret was never written deploys fine and then fails to
start. Verify the run.app URL by hand after the first deploy.
────────────────────────────────────────────────────────────────────────
EOF
else
  cat <<EOF
The deploy account already has a key, listed above, and GCP_DEPLOY_KEY in
Infisical \`production\` /deploy is presumably it — this script cannot
read either to confirm. **Do not mint another**: two valid keys is a
worse position than one, because nothing then says which to revoke.

To ROTATE deliberately, create the new one, put it in Infisical, run
infra/infisical/push-github-secrets.sh, watch one deploy go green, and
only then delete the old id:

  gcloud iam service-accounts keys delete <id> --iam-account=$DEPLOY_SA

If the secret has never been written, that is the step this run cannot
see and the one a first deploy fails on:

  infra/gcp/push-cloudrun-env.sh $PROJECT
────────────────────────────────────────────────────────────────────────
EOF
fi
