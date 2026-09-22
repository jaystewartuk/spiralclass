#!/usr/bin/env bash
# Seed the preview DB without ever writing secrets to disk. Pulls exactly what
# apps/web/scripts/seed.ts reads from Infisical — the list, and the reason each
# value is or is not on it, lives in seed-env.sh — and calls tsx directly,
# bypassing the `seed:preview` pnpm script's `dotenv -e .env.preview.local`,
# which needs a file this deliberately never creates. See docs/decisions/D-66.md.
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

# shellcheck source=./seed-env.sh
source "$REPO_ROOT/infra/infisical/seed-env.sh"
infisical_export_seed_secrets

(
  cd "$REPO_ROOT/apps/web"
  pnpm exec tsx scripts/seed.ts
)
