#!/usr/bin/env bash
# The real-DB integration gate. Was .github/workflows/integration.yml until
# D-119 mirrored it here and D-129 deleted the workflow; this is the only copy.
#
# Same four things, in the same order, against the same postgres:16 image:
#   1. a production `next build --turbopack` (route/slug/manifest validation)
#   2. scripts/check-build-output.mjs (middleware compiled, no secret in a chunk)
#   3. a migration-drift check on a throwaway database
#   4. the vitest `integration` project, asserted to have actually run something
#
# Differences from the workflow, all deliberate:
#   * Postgres comes from apps/web/docker-compose.test.yml (port 5433, a named
#     volume) instead of an Actions service container, so it survives between
#     runs — migrations are `migrate deploy` and therefore idempotent. Set
#     GATE_FRESH_DB=1 to drop and recreate it the way a fresh runner would.
#   * `createdb` / `psql` run INSIDE the container via `docker compose exec`,
#     so no local libpq client is needed on the laptop.
#   * The stale SUPABASE_* / VERCEL_ENV stubs the workflow still exports are
#     gone: both platforms are decommissioned (D-89 Phase 5), nothing reads
#     them, and copying dead env into a new file is how it comes back.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Serialize against every other checkout on this machine (D-146). This suite
# owns shared, singleton resources for its whole duration: the
# `spiralclass-test-db` container (one fixed name, one port 5433, no matter
# which worktree booted it) and a `next build` running with a 6GB heap ceiling.
# Two concurrent runs do not just compete for RAM — the drift check below drops
# and recreates `spiralclass_drift` WITH (FORCE) underneath the other one, and
# GATE_FRESH_DB=1 removes the volume entirely.
#
# The lock is taken HERE and not only in gate.mjs so that the guarantee holds
# for every entry point, including a hand-run `pnpm test:integration:local`.
# When the gate already holds the machine it passes straight through — see the
# re-entrancy note in scripts/ci/lock.mjs.
if [ "${SPIRALCLASS_LOCK_INNER:-}" != "1" ]; then
  exec env SPIRALCLASS_LOCK_INNER=1 \
    node scripts/ci/lock.mjs run --label "integration" -- bash "$0" "$@"
fi

COMPOSE=(docker compose -f apps/web/docker-compose.test.yml)

PGHOST_URL="postgresql://test:test@localhost:5433"
export TEST_DATABASE_URL="${PGHOST_URL}/spiralclass_test"
DRIFT_DATABASE_URL="${PGHOST_URL}/spiralclass_drift"

# The app under test must not think it has a real database beyond the one the
# integration project connects to itself — same stub the workflow uses.
export DATABASE_URL="postgresql://stub:stub@localhost:9999/stub"
export DIRECT_URL="$DATABASE_URL"
export APP_URL="http://localhost:3000"
export SESSION_SECRET="stubsessionsecret-must-be-long-enough"

psql_root() { "${COMPOSE[@]}" exec -T test-db psql -U test -d postgres -v ON_ERROR_STOP=1 "$@"; }

echo "── Postgres (docker compose, port 5433)"
if [ "${GATE_FRESH_DB:-0}" = "1" ]; then
  "${COMPOSE[@]}" down -v
fi
"${COMPOSE[@]}" up -d --wait

echo "── Apply migrations"
DATABASE_URL="$TEST_DATABASE_URL" DIRECT_URL="$TEST_DATABASE_URL" \
  pnpm --filter spiralclass-web exec prisma migrate deploy

echo "── Production build (route + build validation)"
(
  cd apps/web
  DATABASE_URL="$TEST_DATABASE_URL" DIRECT_URL="$TEST_DATABASE_URL" \
    E2E_STRIPE_STUB=1 NODE_OPTIONS="--max-old-space-size=6144" \
    pnpm exec next build --turbopack

  echo "── Assert build output"
  DATABASE_URL="$TEST_DATABASE_URL" DIRECT_URL="$TEST_DATABASE_URL" \
    node scripts/check-build-output.mjs
)

echo "── Migration drift check"
# Rebuilt every run: the question is "do the committed migrations reproduce
# schema.prisma from nothing", which a reused database can't answer.
psql_root -c 'DROP DATABASE IF EXISTS spiralclass_drift WITH (FORCE)' >/dev/null
psql_root -c 'CREATE DATABASE spiralclass_drift' >/dev/null
(
  cd apps/web
  DATABASE_URL="$DRIFT_DATABASE_URL" DIRECT_URL="$DRIFT_DATABASE_URL" \
    pnpm exec prisma migrate deploy >/dev/null
  # Prisma 7 removed `--from-url` and renamed `--to-schema-datamodel`. The URL
  # now reaches the CLI only through prisma.config.ts, which reads DIRECT_URL —
  # already exported above for `migrate deploy` — so `--from-config-datasource`
  # names the same drift database the previous flag spelled out inline.
  DATABASE_URL="$DRIFT_DATABASE_URL" DIRECT_URL="$DRIFT_DATABASE_URL" \
    pnpm exec prisma migrate diff \
    --from-config-datasource \
    --to-schema prisma/schema.prisma \
    --script >"${TMPDIR:-/tmp}/spiralclass-drift.sql"

  echo "----- reconciliation script -----"
  cat "${TMPDIR:-/tmp}/spiralclass-drift.sql"
  echo "---------------------------------"
  if grep -iE 'CREATE TABLE|DROP TABLE|ADD COLUMN|DROP COLUMN|RENAME COLUMN|SET DATA TYPE|SET NOT NULL|DROP NOT NULL|CREATE TYPE|ALTER TYPE|DROP TYPE' \
    "${TMPDIR:-/tmp}/spiralclass-drift.sql" | grep -q .; then
    echo ""
    echo "  schema.prisma has model changes no migration captures."
    echo "  Fix: pnpm --filter spiralclass-web prisma:migrate  (then commit the migration)"
    exit 1
  fi
  echo "No model drift detected."
)

echo "── Integration suite"
RESULTS="apps/web/integration-results.json"
SKIP_GLOBAL_MIGRATE=1 pnpm --filter spiralclass-web exec vitest run --project integration \
  --passWithNoTests --reporter=default --reporter=json --outputFile=integration-results.json

# A suite that connects to nothing and skips everything is green and worthless —
# the workflow asserts this too, for the same reason (a bad TEST_DATABASE_URL
# used to look like a pass).
passed="$(node -e "const r=require('./${RESULTS}'); console.log(r.numPassedTests||0)")"
echo "Integration tests passed: ${passed}"
if [ "$passed" -lt 1 ]; then
  echo "  The integration project ran zero tests — treating that as a failure."
  echo "  Usually TEST_DATABASE_URL isn't reaching the suite, or the container isn't up."
  exit 1
fi
