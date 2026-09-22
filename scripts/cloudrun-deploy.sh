#!/usr/bin/env bash
# The THIRD production target, and the one meant to replace the first.
#
# [D-184]. Fly `agendaprofe` serves spiralclass.com and is untouched by this
# file. The Vercel failover ([D-177]) is untouched by it too. What this adds is
# a Cloud Run service that is built and deployed on every release, holds no
# domain, and exists so that the operator can hand it the domain and stop paying
# Fly ~$7/month for a platform that earns nothing.
#
# ⚠️ WHAT THIS DELIBERATELY DOES NOT DO. The list is the same five as
# scripts/vercel-deploy.sh's, for the same reasons, and each omission is load
# bearing rather than unfinished:
#
#   * NO Neon checkpoint (D-95) and NO migrations. scripts/database-deploy.sh
#     owns both, and deploy-production.yml runs it as the `database` job this
#     job `needs:`. One commit, one migration run, in the job that checkpoints
#     first. ⚠️ FROM A LAPTOP that ordering is yours to keep: if the commit
#     carries a migration, run scripts/database-deploy.sh for it first — this
#     script holds no database credential and cannot tell.
#   * NO Inngest sync, and this is the sharp one. scripts/inngest-sync.sh PUTs
#     an endpoint URL and Inngest registers an app PER URL. A second URL would
#     register a second app, so a cron defined once would FIRE TWICE — once from
#     Fly and once from a deployment serving nobody. Some of those crons bill
#     Stripe customers. The Inngest endpoint belongs to whichever deployment
#     holds the domain. At cutover it MOVES; it is never added.
#   * NO domain. There is no `gcloud run domain-mappings create` here and there
#     must not be. A DNS cutover performed by a CI job is exactly what
#     CLAUDE.md's first rule reserves to the operator.
#   * NO production probe. scripts/local/synthetic.sh probes
#     https://spiralclass.com, which this deploy does not serve. Pointing it at
#     the run.app URL would be a second definition of "is production healthy".
#   * NO runtime secrets. See CREDENTIALS below — this script cannot read one
#     and does not want to.
#
# So the ordered steps are four:
#
#   1. resolve the build-time NEXT_PUBLIC_* values from the SAME source the Fly
#      image and the Vercel build read — config/env/<env>.build.env, through
#      scripts/env-build-args.mjs. Three targets baking different values into
#      one commit's client bundle is a class of bug with no runtime symptom.
#   2. build apps/web's amd64 image with docker buildx and push it to Artifact
#      Registry, tagged with the commit SHA
#   3. `gcloud run deploy --image` it, with the shape from
#      config/cloudrun/<env>.env
#   4. record the deploy in the local release ledger
#
# CREDENTIALS, and why the runtime secrets are not here. On Fly they are
# `fly secrets`, pushed from Infisical by the operator; the deploy only swaps
# the image. Cloud Run's equivalent is a Secret Manager secret holding the whole
# set as one env-file, mounted into the container and sourced by
# scripts/docker-entrypoint.sh. infra/gcp/push-cloudrun-env.sh (operator, under
# their own `infisical login`) writes it; every release after that changes the
# image and nothing else.
#
# That mount is why this script holds no Infisical credential, no DATABASE_URL
# and no Stripe key, AND why it genuinely cannot read one: the deploy service
# account is never granted `secretAccessor`, so it can name the secret in a
# --set-secrets flag and still not read its contents. Only the RUNTIME service
# account can. This deploys production and cannot read it — the same boundary
# [D-163]'s addendum drew for the runner, and for the same reason: a step that
# can reach the vault hands that capability to every other step in the job,
# `pnpm install` included.
#
# ⚠️ That property is exactly what plain `--set-env-vars` would have thrown
# away, and it is why the secrets are not passed that way. It also keeps them
# out of argv, which D-66 requires: gcloud's env-var flags take values as
# process arguments, where `ps` can read them.
#
# ⚠️ ONE CONSEQUENCE, stated because it is the way this goes wrong: a service
# whose secret has never been written deploys FINE and then fails at boot —
# the entrypoint exits on a missing mount, and Cloud Run reports a container
# that would not start. The preflight below cannot catch it, holding no
# credential to look with, so the first deploy to a new service is the
# operator's to verify. infra/gcp/README.md says so in its own words.
#
# WHY AUTH IS A KEY AND NOT WORKLOAD IDENTITY FEDERATION, which is the opposite
# of the usual advice and was reversed rather than chosen. WIF needs
# `id-token: write`; GitHub grants that per JOB, not per step; and this job
# builds a Docker image — so every lifecycle script in the dependency tree would
# run with a token-minting endpoint in front of it. [D-163]'s addendum reversed
# that exact shape once, and apps/web/tests/config/local-gate.test.ts bans it in
# every workflow here. This job is the worst candidate for an exception, not the
# best: it runs more third-party code than any other.
#
# So GCP_DEPLOY_KEY is a service-account key for an identity that can deploy a
# revision and cannot read a secret — the same shape, blast radius and rotation
# story as FLY_API_TOKEN. Its cost is that it is long-lived, and
# infra/gcp/README.md owns the rotation.
#
# ⚠️ From a LAPTOP, leave GCP_DEPLOY_KEY unset: the operator's own `gcloud auth
# login` is used instead, exactly as scripts/fly-deploy.sh falls back to their
# own `infisical login`. A deploy from either place is otherwise identical.
set -euo pipefail

ENVIRONMENT="${1:-}"
shift || true

case "$ENVIRONMENT" in
  production) ;;
  *)
    echo "usage: scripts/cloudrun-deploy.sh production --gate-already-passed" >&2
    echo "" >&2
    echo "Only \`production\` exists as a Cloud Run target. Preview belongs to Fly" >&2
    echo "(D-150's addendum), and a second service would be a second thing to keep" >&2
    echo "in sync for no stated reason." >&2
    exit 1
    ;;
esac

# The same handoff scripts/fly-deploy.sh demands, for the same reason: this can
# put a commit in front of real students, and the only thing that should is a
# commit `pnpm promote` has already run the full gate against. A misspelt flag
# is a usage error rather than a silent full-gate skip.
GATE_PASSED=0
for arg in "$@"; do
  case "$arg" in
    --gate-already-passed) GATE_PASSED=1 ;;
    *)
      echo "unknown argument: $arg" >&2
      echo "usage: scripts/cloudrun-deploy.sh production --gate-already-passed" >&2
      exit 1
      ;;
  esac
done
if [ "$GATE_PASSED" -ne 1 ]; then
  echo "cloudrun-deploy: refusing to deploy production without the full promote gate." >&2
  echo "" >&2
  echo "\`pnpm promote\` runs it and then dispatches this. To deploy anyway, pass" >&2
  echo "--gate-already-passed and own that decision." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SHAPE="config/cloudrun/$ENVIRONMENT.env"
[ -f "$SHAPE" ] || {
  echo "cloudrun-deploy: $SHAPE not found." >&2
  exit 1
}
# shellcheck disable=SC1090
set -a && . "./$SHAPE" && set +a

# ---------------------------------------------------------------------------
# 0. Refuse before building if anything this job reads did not arrive.
#
# Same trap as every other preflight here: an ABSENT GitHub secret is the empty
# string, not an error. Without this, a value Infisical has not pushed reaches
# gcloud looking exactly like a value that is set, and the first symptom is a
# message about a project that is in fact configured.
# ---------------------------------------------------------------------------
missing=""
[ -n "${GCP_PROJECT_ID:-}" ] || missing="$missing GCP_PROJECT_ID"
for v in SERVICE REGION CPU MEMORY MIN_INSTANCES MAX_INSTANCES ARTIFACT_REPO SECRET_NAME SECRETS_PATH RUNTIME_SA_ID; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || missing="$missing $v(from $SHAPE)"
done
if [ -n "$missing" ]; then
  echo "cloudrun-deploy: missing:$missing" >&2
  echo "" >&2
  echo "GCP_PROJECT_ID is an account identifier and is deliberately not in this" >&2
  echo "tree (D-158). Infisical is the source of truth and syncs it into the" >&2
  echo "\`production\` GitHub Environment (D-163) — fix the value THERE rather" >&2
  echo "than setting it by hand here." >&2
  exit 1
fi

command -v gcloud >/dev/null || {
  echo "cloudrun-deploy: no \`gcloud\` on PATH." >&2
  exit 1
}

# ── Authenticate, if a key was supplied ──────────────────────────────────
#
# The key reaches gcloud through a FILE, never through argv (D-66): gcloud's
# --key-file takes a path, and a path is all that appears in the process list.
# Created under umask 077 in a directory this script owns and removes, so it is
# never world-readable and never outlives the run.
#
# Unset means a laptop under the operator's own `gcloud auth login`.
if [ -n "${GCP_DEPLOY_KEY:-}" ]; then
  KEY_DIR="$(umask 077 && mktemp -d)"
  trap 'rm -rf "$KEY_DIR"' EXIT INT TERM
  (umask 077 && printf '%s' "$GCP_DEPLOY_KEY" > "$KEY_DIR/key.json")
  gcloud auth activate-service-account --key-file="$KEY_DIR/key.json" --project "$GCP_PROJECT_ID"
else
  echo "› No GCP_DEPLOY_KEY — using this machine's own \`gcloud auth login\`."
fi

SHA="$(git rev-parse HEAD)"
SHORT_SHA="$(git rev-parse --short=12 HEAD)"
IMAGE="$REGION-docker.pkg.dev/$GCP_PROJECT_ID/$ARTIFACT_REPO/web:$SHORT_SHA"

echo "› Deploying $SHORT_SHA to Cloud Run $SERVICE ($REGION)."
echo "  It will serve its run.app URL and NOT spiralclass.com (D-184)."

# ---------------------------------------------------------------------------
# 1. Build args, from the one source all three targets read.
# ---------------------------------------------------------------------------
BUILD_ARGS=()
while IFS= read -r line; do
  case "$line" in
    "" | \#* | *"<<"* | EOF) continue ;;
  esac
  BUILD_ARGS+=(--build-arg "$line")
done < <(node scripts/env-build-args.mjs "$ENVIRONMENT")

if [ "${#BUILD_ARGS[@]}" -eq 0 ]; then
  echo "cloudrun-deploy: env-build-args.mjs produced nothing — refusing to bake" >&2
  echo "a client bundle with no NEXT_PUBLIC_* values into a production image." >&2
  exit 1
fi

# NEXT_DEPLOYMENT_ID is what Next stamps on asset requests as `?dpl=`, so a
# client left on an old build gets a hard navigation instead of silently pulling
# chunks the new deploy renamed. The Fly build passes the commit here; a target
# that did not would reintroduce AGENDAPROFE-3B on its own.
BUILD_ARGS+=(--build-arg "NEXT_DEPLOYMENT_ID=$SHORT_SHA")

# ---------------------------------------------------------------------------
# 2. Build amd64 and push.
#
# Cloud Run runs amd64. On the operator's arm64 Mac this is a QEMU cross-build
# (20-30+ min, flaky with threaded native addons); on ubuntu-latest it is
# native. That asymmetry is [D-157]'s whole argument and applies here unchanged.
# ---------------------------------------------------------------------------
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet --project "$GCP_PROJECT_ID"

docker buildx build \
  --platform linux/amd64 \
  "${BUILD_ARGS[@]}" \
  --tag "$IMAGE" \
  --push \
  .

# ---------------------------------------------------------------------------
# 3. Deploy.
#
# --update-env-vars, NEVER --set-env-vars: the latter REPLACES the service's
# whole environment, which would delete every secret push-cloudrun-env.sh put
# there and leave production 503ing with a Zod parse error. APP_ENV is the one
# value this script owns, because it is what scripts/docker-entrypoint.sh reads
# to choose which config/env/<env>.runtime.env to source — the same job
# fly.<env>.toml's [env] does.
#
# The shape flags are passed on every deploy rather than set once, for the
# reason fly.production.toml's `[[vm]]` block gives about `fly scale vm`: a
# hand-made change in a console that the next deploy silently reverts is how a
# fix turns back into the same outage a week later. config/cloudrun/<env>.env is
# the source of truth and says so out loud.
# ---------------------------------------------------------------------------
BOOST=()
[ "${CPU_BOOST:-0}" = "1" ] && BOOST=(--cpu-boost)

# The secret set, mounted as a FILE rather than exploded into env vars. Values
# never enter argv (D-66) — only the secret's NAME does — and the deploy
# identity holds no `secretAccessor`, so this flag names something this script
# cannot read. SECRETS_ENV_FILE is what tells the entrypoint to source it.
gcloud run deploy "$SERVICE" \
  --project "$GCP_PROJECT_ID" \
  --region "$REGION" \
  --image "$IMAGE" \
  --platform managed \
  --port 3000 \
  --cpu "$CPU" \
  --memory "$MEMORY" \
  --min-instances "$MIN_INSTANCES" \
  --max-instances "$MAX_INSTANCES" \
  "${BOOST[@]}" \
  --service-account "$RUNTIME_SA_ID@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
  --set-secrets "$SECRETS_PATH=$SECRET_NAME:latest" \
  --update-env-vars "APP_ENV=$ENVIRONMENT,SECRETS_ENV_FILE=$SECRETS_PATH" \
  --allow-unauthenticated \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --project "$GCP_PROJECT_ID" --region "$REGION" --format='value(status.url)')"
echo "› Deployed: $URL"
echo "  Serving: its own URL only. spiralclass.com is still Fly (D-150 addendum 2)."

# ---------------------------------------------------------------------------
# 4. Ledger.
#
# A distinct --kind, like vercel-deploy.sh's: `pnpm release:status` must not
# report this as the thing serving spiralclass.com, because it is not.
# ---------------------------------------------------------------------------
node scripts/ci/record-release.mjs --kind web-deploy-cloudrun --env "$ENVIRONMENT" --sha "$SHA" || true
