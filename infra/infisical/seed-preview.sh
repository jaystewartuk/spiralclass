#!/usr/bin/env bash
# Seed the preview DB without ever writing secrets to disk. Pulls only the
# 2 keys apps/web/scripts/seed.ts actually reads from Infisical
# (DATABASE_URL, DIRECT_URL) via with-secret.sh's shared helper, and calls
# tsx directly — bypassing the `seed:preview` pnpm script's
# `dotenv -e .env.preview.local`, which needs a file this deliberately never
# creates. See docs/decisions/D-66.md.
#
# Requires: the Infisical CLI installed and logged in (`infisical login`).
#
# Usage:
#   ./infra/infisical/seed-preview.sh                        # core seed only
#   SEED_BULK_TEACHERS=40 ./infra/infisical/seed-preview.sh   # + bulk volume
#   pnpm seed:preview                                    # same, via root script
#   SEED_BULK_TEACHERS=40 pnpm seed:preview              # same, with bulk volume
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"

# shellcheck source=./with-secret.sh
source "$REPO_ROOT/infra/infisical/with-secret.sh"
infisical_export_secrets DATABASE_URL DIRECT_URL

# SEED_STRIPE_ACCOUNT_ID is OPTIONAL, so it is fetched separately and allowed
# to fail.
#
# The seed uses it to give the Stripe-ready hero a REAL test-mode connected
# account instead of the fabricated `acct_seed_*` stub, which Stripe answers
# with `403 account_invalid` — the whole reason the card rail was untestable on
# preview. Absent, seed.ts falls back to the stub, which is what CI and a fresh
# checkout want.
#
# It cannot join the list above: `infisical_export_secrets` hard-fails on an
# empty result (deliberately — see with-secret.sh), so a missing optional key
# would break the seed entirely for anyone who has not set one.
infisical_export_secrets SEED_STRIPE_ACCOUNT_ID || {
  echo "  (no SEED_STRIPE_ACCOUNT_ID in Infisical preview — seeding the acct_seed_* stub)" >&2
}

(
  cd "$REPO_ROOT/apps/web"
  pnpm exec tsx scripts/seed.ts
)
