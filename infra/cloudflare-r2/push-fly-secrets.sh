#!/usr/bin/env bash
# Push one environment's R2 bucket credentials (5 env vars each) from this
# module's OpenTofu state to the matching Fly app's secrets — see README.md
# and D-65. There is no Tofu Fly provider in this repo (deliberate — see
# D-65's rationale); this script is how R2 creds reach Fly. Everything runs on
# Fly now (no more Vercel — the infra/vercel module was removed), so BOTH
# environments go through this one script, differing only by which
# `environment` it filters and which Fly app it targets.
#
# Run AFTER `tofu apply` has created the buckets/tokens for the environment
# you're pushing (this reads Tofu's own state via `tofu output`, not the
# Cloudflare API directly).
#
# Usage — pass ENVIRONMENT (preview|production) and the matching FLY_APP:
#   ENVIRONMENT=preview    FLY_APP=agendaprofe-preview ./push-fly-secrets.sh
#   ENVIRONMENT=production FLY_APP=agendaprofe          ./push-fly-secrets.sh
#
# NOTE the app names: the PRODUCTION Fly app is `agendaprofe`; the PREVIEW app
# is `agendaprofe-preview` (see fly.production.toml / fly.preview.toml). Do not
# assume `agendaprofe` == preview — that was true before the prod/preview Fly
# split, and pushing preview creds to it now would overwrite production.
#
# Pushing "production" repoints live production storage — this is the deferred
# post-launch cutover (see README's migration note). Only run it once the
# objects are migrated (aws s3 sync old bare bucket → new spiralclass-
# production-* twin) and you intend the production app to start reading the
# new buckets.
#
# UNVERIFIED IN THIS SESSION: `fly secrets import`'s exact stdin format is
# best-effort from documented flyctl usage. If `flyctl` rejects the input, fix
# this script against the real CLI output before retrying — don't fall back to
# `fly secrets set KEY=value ...` on the command line, which would leak secret
# values into shell history / `ps`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

: "${ENVIRONMENT:?export ENVIRONMENT=preview or production}"
: "${FLY_APP:?export FLY_APP=<the fly.toml app name: agendaprofe-preview for preview, agendaprofe for production>}"
case "$ENVIRONMENT" in
  preview|production) ;;
  *) echo "ENVIRONMENT must be 'preview' or 'production', got '${ENVIRONMENT}'" >&2; exit 1 ;;
esac

TOFU="$(command -v tofu || command -v terraform)" || { echo "install OpenTofu (brew install opentofu) or Terraform" >&2; exit 1; }
command -v flyctl >/dev/null || command -v fly >/dev/null || { echo "install flyctl (https://fly.io/install.sh)" >&2; exit 1; }
FLYCTL="$(command -v flyctl || command -v fly)"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

echo "Reading '${ENVIRONMENT}' bucket credentials from Tofu state …" >&2
BUCKETS_JSON="$("$TOFU" output -json buckets)"

# One "KEY=value" line per (bucket × field) for the selected environment —
# piped to `fly secrets import` via stdin so values never touch
# argv/shell history/`ps`.
SECRETS_INPUT="$(echo "$BUCKETS_JSON" | jq -r --arg env "$ENVIRONMENT" '
  to_entries
  | map(select(.value.environment == $env))
  | map(
      .value as $cfg |
      [
        "\($cfg.env_prefix)_BUCKET=\($cfg.bucket)",
        "\($cfg.env_prefix)_ENDPOINT=\($cfg.endpoint)",
        "\($cfg.env_prefix)_REGION=\($cfg.region)",
        "\($cfg.env_prefix)_ACCESS_KEY=\($cfg.access_key_id)",
        "\($cfg.env_prefix)_SECRET=\($cfg.secret_access_key)"
      ]
    )
  | flatten
  | .[]
')"

COUNT="$(echo "$SECRETS_INPUT" | grep -c '=' || true)"
if [ "$COUNT" -eq 0 ]; then
  echo "No '${ENVIRONMENT}' buckets found in Tofu state — nothing to push. Did you 'tofu apply' the spiralclass-${ENVIRONMENT}-* entries yet?" >&2
  exit 1
fi

echo "Pushing ${COUNT} secrets to Fly app '${FLY_APP}' (this restarts running machines) …" >&2
echo "$SECRETS_INPUT" | "$FLYCTL" secrets import --app "$FLY_APP"

echo >&2
echo "Done. Verify with: fly secrets list --app ${FLY_APP} (names only, values are never shown)." >&2
