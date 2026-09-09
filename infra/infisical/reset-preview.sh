#!/usr/bin/env bash
# Reset + reseed the preview DB without ever writing secrets to disk. Pulls
# DATABASE_URL/DIRECT_URL from Infisical (env=preview) the same way
# scripts/fly-deploy.sh and seed-preview.sh reach preview — never via
# apps/web/.env.preview.local, which this deliberately doesn't need.
#
# Two steps:
#   1. `prisma migrate reset --force` against the DIRECT connection — drops
#      every table and reapplies every migration from scratch. This is the
#      part `seed:preview`/`seed-preview.sh` do NOT do: that script is
#      idempotent for SEED rows only (deletes+reinserts seed teachers/
#      students), so leftover junk from manual testing or a stale Maestro run
#      survives a plain reseed. Use this script when you actually want a
#      clean slate, not just fresh seed data.
#   2. The seed script (apps/web/scripts/seed.ts) — same as seed-preview.sh.
#
# Requires: the Infisical CLI installed and logged in (`infisical login`).
#
# Usage:
#   ./infra/infisical/reset-preview.sh                        # reset + core seed
#   SEED_BULK_TEACHERS=40 ./infra/infisical/reset-preview.sh  # + bulk volume
#   pnpm reset:preview                                    # same, via root script
#   just reset-preview                                    # same, via justfile
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"

# shellcheck source=./with-secret.sh
source "$REPO_ROOT/infra/infisical/with-secret.sh"
infisical_export_secrets DATABASE_URL DIRECT_URL

echo "› Resetting preview DB (drops ALL data, reapplies every migration)…"
(
  cd "$REPO_ROOT/apps/web"
  pnpm exec tsx scripts/migrate-regions.ts migrate reset --force
)

echo "› Reseeding preview DB…"
(
  cd "$REPO_ROOT/apps/web"
  pnpm exec tsx scripts/seed.ts
)

echo "› Preview DB reset + reseeded."
