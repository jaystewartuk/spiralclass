#!/usr/bin/env bash
# Adopt the EXISTING, live, dashboard-created R2 buckets + their R2 API
# tokens into OpenTofu state WITHOUT recreating or rotating them — see
# README.md "Adopt the existing buckets". Run ONCE per bucket, after
# `tofu init -backend-config=backend.hcl`.
#
# CRITICAL: these buckets hold real production data and the tokens are
# live credentials the app depends on right now. A bare `tofu apply`
# against empty state would try to CREATE a same-named bucket (fails, R2
# names are globally unique per account — safe) and a NEW token (succeeds,
# silently orphaning the one the app is actually using — NOT safe). Import
# first; only trust an `apply` after this script's `tofu plan` reports
# "No changes".
#
# Usage (per bucket — the token id is NOT guessable, look it up first):
#   TOKEN_ID=<the existing token's id from the Cloudflare dashboard> \
#     ./import.sh agendaprofe-class-materials
#   TOKEN_ID=… ./import.sh agendaprofe-teacher-photos
#   TOKEN_ID=… ./import.sh agendaprofe-chat-audio
#   TOKEN_ID=… ./import.sh agendaprofe-recordings
#
# The four agendaprofe-preview-* buckets (see D-65) are NEW — apply, don't
# import, those (nothing exists yet to adopt).
#
# Find TOKEN_ID: dashboard → the account's "Account API Tokens" list (NOT
# "My Profile → API Tokens" — these buckets' tokens live in the
# account-scoped registry, confirmed live 2026-07-12; a token id copied from
# the wrong list 404s on import even though it "looks like a token id") →
# the r2-<bucket>-rw token (or whatever it's currently named) → the token's
# id is in its detail-page URL.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

: "${CLOUDFLARE_API_TOKEN:?export a Cloudflare API token with R2 + API Tokens read/edit first}"
: "${TOKEN_ID:?export TOKEN_ID=<existing api token id for this bucket>}"
BUCKET="${1:?usage: TOKEN_ID=... ./import.sh <bucket-name>}"

TOFU="$(command -v tofu || command -v terraform)" || { echo "install OpenTofu (brew install opentofu) or Terraform" >&2; exit 1; }

ACCOUNT_ID="$(grep -E '^account_id' terraform.tfvars | sed -E 's/.*=\s*"([^"]+)".*/\1/')"
: "${ACCOUNT_ID:?set account_id in terraform.tfvars first}"

echo "Importing bucket '${BUCKET}' (account ${ACCOUNT_ID}) → cloudflare_r2_bucket.this[\"${BUCKET}\"] …" >&2
# Import ID is account_id/bucket_name/jurisdiction (confirmed against the
# cloudflare_r2_bucket resource schema — "jurisdiction" defaults to
# "default" for a bucket created without an explicit jurisdiction, which is
# every bucket this module manages).
"$TOFU" import "cloudflare_r2_bucket.this[\"${BUCKET}\"]" "${ACCOUNT_ID}/${BUCKET}/default"

echo "Importing token ${TOKEN_ID} → cloudflare_account_token.r2[\"${BUCKET}\"] …" >&2
# Import ID format is a best-effort guess (account_id/token_id, matching
# the same account-scoped pattern as the bucket import above) — not yet
# confirmed live. If this 404s or errors on shape, check the resource's
# import example at
# registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/account_token
# (likely alternative: just "${TOKEN_ID}", no account_id prefix).
"$TOFU" import "cloudflare_account_token.r2[\"${BUCKET}\"]" "${ACCOUNT_ID}/${TOKEN_ID}"

echo >&2
echo "Verifying — this should say 'No changes'. A diff on the token's" >&2
echo "'policies'/'resources' means the guessed R2 resource-scoping JSON" >&2
echo "key in main.tf doesn't match what the dashboard actually wrote —" >&2
echo "fix main.tf to match the imported state, do NOT apply to force it." >&2
"$TOFU" plan

echo >&2
echo "Next: verify the access-key derivation (main.tf's md5(id)/sha256(value))" >&2
echo "actually matches this token's REAL currently-configured access key before you" >&2
echo "add any bucket this module didn't already inherit from a clean import —" >&2
echo "see README.md 'Before the first real apply'." >&2
