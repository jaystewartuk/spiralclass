#!/usr/bin/env bash
# Push the SES-sender IAM credential from this module's OpenTofu state to
# Infisical's "preview" environment (→ synced to the Fly preview app — see
# infra/infisical/README.md and D-66). Production goes to the production Fly
# app by hand for now — see README.md.
#
# Run AFTER `tofu apply` has created aws_iam_access_key.ses_sender (this
# reads Tofu's own state via `tofu output`, not the AWS API directly).
#
# Usage:
#   ./push-infisical-secrets.sh
#
# UNVERIFIED IN THIS SESSION: no network path to app.infisical.com, so the
# exact `infisical secrets set` invocation below is best-effort from
# documented CLI usage, not confirmed live — see infra/infisical/README.md's
# own "UNVERIFIED IN THIS SESSION" note on secret references for the same
# caveat pattern. If `infisical secrets set` rejects the flags, check
# `infisical secrets set --help` and fix this script rather than falling
# back to pasting the secret into the dashboard by hand (fine as a one-off,
# but defeats the point of scripting this).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

TOFU="$(command -v tofu || command -v terraform)" || { echo "install OpenTofu (brew install opentofu) or Terraform" >&2; exit 1; }
command -v infisical >/dev/null || { echo "install the Infisical CLI (brew install infisical/get-cli/infisical)" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

echo "Reading SES-sender credentials from Tofu state …" >&2
CREDS_JSON="$("$TOFU" output -json credentials)"
ACCESS_KEY_ID="$(echo "$CREDS_JSON" | jq -r '.access_key_id')"
SECRET_ACCESS_KEY="$(echo "$CREDS_JSON" | jq -r '.secret_access_key')"

if [ -z "$ACCESS_KEY_ID" ] || [ "$ACCESS_KEY_ID" = "null" ]; then
  echo "No credentials found in Tofu state — did you 'tofu apply' yet?" >&2
  exit 1
fi

echo "Pushing SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY to Infisical (preview env) …" >&2
# This directory has no .infisical.json of its own — infra/infisical/
# .infisical.json is the one shared project link every module
# uses. Unlike `infisical run` (which has
# --project-config-dir), `infisical secrets set` has no equivalent flag —
# confirmed via `infisical secrets set --help` — so a subshell `cd` is the
# actual supported mechanism, not an unverified flag.
# shellcheck source=../infisical/infisical.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../infisical" && pwd)/infisical.sh"
infisical_put preview \
  "SES_ACCESS_KEY_ID=${ACCESS_KEY_ID}" \
  "SES_SECRET_ACCESS_KEY=${SECRET_ACCESS_KEY}"

echo >&2
echo "Done. Confirm with: infisical secrets --env=preview (values redacted in listing)." >&2
echo >&2
echo "Non-secret SES_REGION/SES_FROM still need uncommenting by hand in" >&2
echo "fly.toml's [env] block (see fly.toml's Amazon SES comment) — this" >&2
echo "script only handles the two genuinely-secret vars." >&2
echo >&2
echo "Production is NOT covered by this script — set the same two values on" >&2
echo "the production Fly app (fly secrets / Infisical 'production' env) by" >&2
echo "hand; see infra/aws-ses/README.md Part D." >&2
