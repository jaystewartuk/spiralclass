#!/usr/bin/env bash
# Push the production app's runtime SECRETS into the Vercel failover's project
# ([D-177]) — the same two sets Fly gets, from the same two places:
#
#   * Infisical `production` at `/`, not recursive — exactly what
#     push-fly-secrets.sh imports into Fly. Never `/config` and never `/deploy`,
#     for D-163's reason: `/` is the path that becomes an environment variable
#     inside the running app, and a deploy credential has no business there.
#   * The production R2 buckets' credentials, from infra/cloudflare-r2's Tofu
#     state — exactly what that module's push-fly-secrets.sh sets on Fly (D-65).
#
# The committed runtime config (config/env/production.runtime.env) is NOT
# pushed here. It is public and it changes with the commit, so
# scripts/vercel-deploy.sh syncs it on every release. scripts/vercel-env.mjs's
# header explains how the two writers share the store without a list of names.
#
# Every value is written `sensitive`: Vercel never decrypts it again, for the
# dashboard or for the VERCEL_TOKEN the deploy job holds. The cost is that
# nothing can check a value, only that its name is set — so re-run this after
# ANY rotation, in Infisical or in Tofu.
#
# STALE NAMES are reported, and deleted only behind --delete-stale, for the
# reason push-github-secrets.sh gives: a delete cannot be undone, and the report
# is what lets a human confirm the list before it goes.
#
# Values flow through stdin only, never argv (D-66). `printf` below is a bash
# builtin, so the JSON it writes is never a process argument either.
#
# Requires: the Infisical CLI (logged in), OpenTofu with infra/cloudflare-r2
# initialised, and node. `tofu output` reads an R2-hosted state backend, so
# run it the way that module's own commands run, with the `infra` credentials:
#
#   infisical run --project-config-dir=infra/infisical --env=infra -- \
#     infra/infisical/push-vercel-env.sh [--delete-stale]
set -euo pipefail
INFISICAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$INFISICAL_DIR/../.." && pwd)"
cd "$REPO_ROOT"

ENVIRONMENT=production

ARGS=""
for arg in "$@"; do
  case "$arg" in
    --delete-stale) ARGS="--delete-stale" ;;
    *)
      echo "unknown argument: $arg" >&2
      echo "usage: infra/infisical/push-vercel-env.sh [--delete-stale]" >&2
      exit 1
      ;;
  esac
done

command -v infisical >/dev/null || {
  echo "install the Infisical CLI: https://infisical.com/docs/cli/overview" >&2
  exit 1
}
TOFU="$(command -v tofu || command -v terraform)" || {
  echo "install OpenTofu (brew install opentofu)" >&2
  exit 1
}
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

# shellcheck source=./infisical.sh
source "$INFISICAL_DIR/infisical.sh"

# ── The project's credentials, from where the deploy's live ──────────────
# `/deploy`, beside FLY_API_TOKEN. Exported into this process for node to read,
# as the Vercel CLI reads them; never passed as arguments.
echo "› Reading the Vercel credentials from Infisical \`${ENVIRONMENT}\` /deploy…" >&2
VERCEL_TOKEN="$(infisical_secrets --path=/deploy --plain "$ENVIRONMENT" VERCEL_TOKEN)"
VERCEL_ORG_ID="$(infisical_secrets --path=/deploy --plain "$ENVIRONMENT" VERCEL_ORG_ID)"
VERCEL_PROJECT_ID="$(infisical_secrets --path=/deploy --plain "$ENVIRONMENT" VERCEL_PROJECT_ID)"
export VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID

# ── Source 1: what Fly imports ───────────────────────────────────────────
# ⚠️ `/` ONLY. See the header, and push-fly-secrets.sh's note on --recursive.
echo "› Reading Infisical \`${ENVIRONMENT}\` / (not recursive)…" >&2
INFISICAL_JSON="$(infisical_env --json "$ENVIRONMENT" /)"

# ── Source 2: the R2 credentials ─────────────────────────────────────────
echo "› Reading the R2 bucket credentials from infra/cloudflare-r2's Tofu state…" >&2
if ! R2_JSON="$(cd infra/cloudflare-r2 && "$TOFU" output -json buckets)"; then
  echo "" >&2
  echo "  \`tofu output -json buckets\` failed in infra/cloudflare-r2. It reads a remote" >&2
  echo "  state backend: run this under the \`infra\` credentials (see this file's header)," >&2
  echo "  after \`tofu init\` in that directory." >&2
  exit 1
fi

# ── Push ─────────────────────────────────────────────────────────────────
{
  printf '{"infisical":'
  printf '%s' "$INFISICAL_JSON"
  printf ',"r2":'
  printf '%s' "$R2_JSON"
  printf '}'
} | node scripts/vercel-env.mjs push ${ARGS:+"$ARGS"}
