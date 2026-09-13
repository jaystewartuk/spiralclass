#!/usr/bin/env bash
# The database half of a deploy — the ONE copy of it, and the only thing in the
# repository that checkpoints and migrates a shared database.
#
# It was steps 1 and 2 of scripts/fly-deploy.sh until 2026-09-12, when the
# production targets became independently deployable ([D-177]'s addendum). The
# steps did not change; who owns them did. While they lived inside the Fly
# deploy, the Vercel failover could only be deployed after a Fly deploy had
# succeeded — so the one time a failover matters, with Fly unavailable, it could
# not be deployed at all. The database is not Fly's, and this is where that
# stops being a comment and becomes the structure.
#
# Two callers, and they must stay two, not three:
#
#   * .github/workflows/deploy-production.yml runs it as the `database` job.
#     Both target jobs `needs:` that job, and neither needs the other — so one
#     commit gets one checkpoint and one migration run, whichever targets deploy.
#   * scripts/fly-deploy.sh runs it first, unless it is told the workflow
#     already has. A hand-run recovery deploy therefore still checkpoints and
#     migrates, exactly as it did before this file existed.
#
# scripts/vercel-deploy.sh does NOT run it and must not: that job is handed no
# database credential, which is the narrowest way to say it has no business
# with the schema ([D-177]).
#
# The steps, in an order that is load-bearing:
#
#   1. (production only) checkpoint the Neon `production` branch, so a bad
#      migration has a named restore point (D-95)
#   2. apply pending Prisma migrations to the target Neon branch
#
# Requires: pnpm, and DATABASE_URL + DIRECT_URL in the environment. Production
# additionally needs npx and a neonctl that can authenticate for the checkpoint
# — `neonctl auth` once per machine, or NEON_API_KEY — and NEON_PROJECT_ID,
# which has no default and must be supplied (see below). No flyctl, no Docker,
# no Vercel CLI: nothing here knows which platform will serve the code.
#
# From a laptop, compose with the wrapper, as for either target:
#
#   infra/infisical/run.sh production scripts/database-deploy.sh production \
#     --yes-i-understand-this-skips-the-promote-gate
#
# Usage:
#   ./scripts/database-deploy.sh preview
#   ./scripts/database-deploy.sh production --gate-already-passed   # what deploy-production.yml and fly-deploy.sh call
#   ./scripts/database-deploy.sh production --yes-i-understand-this-skips-the-promote-gate

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# No default environment, unlike fly-deploy.sh's `preview`. A script whose whole
# job is to change a shared database should never be one missing word away from
# picking which database that is.
ENVIRONMENT="${1:-}"
case "$ENVIRONMENT" in
preview) ;;
production)
  # The same two doors fly-deploy.sh and vercel-deploy.sh open, for the same
  # reason: production is normally reached only after `pnpm promote`'s full gate.
  if [ "${2:-}" != "--gate-already-passed" ] &&
    [ "${2:-}" != "--yes-i-understand-this-skips-the-promote-gate" ]; then
    echo "Refusing to migrate production from a local script without the full promote gate (checks + integration + E2E)." >&2
    echo "Normal path: pnpm promote — it runs the gate, fast-forwards production, and deploy-production.yml calls this for you." >&2
    echo "If you really mean to bypass that here, re-run with: production --yes-i-understand-this-skips-the-promote-gate" >&2
    exit 1
  fi
  ;;
*)
  echo "usage: $0 preview|production [--gate-already-passed|--yes-i-understand-this-skips-the-promote-gate]" >&2
  exit 1
  ;;
esac

# Both must be present — one alone is a half-configured environment, and
# silently falling back to anything for the other half is how you migrate one
# database and deploy against the other.
#
# ⚠️ THIS SCRIPT DOES NOT READ INFISICAL, and [D-163] is why. Its own text says
# the laptop reads these values "through `infra/infisical/run.sh production
# ./scripts/fly-deploy.sh …` rather than from a file that is the copy nobody
# rotates" — the composition is the supported path. CI invokes this with both
# values in the environment.
[ -n "${DATABASE_URL:-}" ] && [ -n "${DIRECT_URL:-}" ] || {
  echo "DATABASE_URL and DIRECT_URL must both be in the environment." >&2
  echo "From a laptop, compose with the wrapper rather than reaching for the CLI here:" >&2
  echo "  infra/infisical/run.sh ${ENVIRONMENT} scripts/database-deploy.sh ${ENVIRONMENT}" >&2
  exit 1
}

SHA="$(git rev-parse HEAD)"

# ── 1. Neon checkpoint (production only) ─────────────────────────────────
# The pre-migration restore point D-95 made production's primary safety net,
# and the one step that did NOT come along when D-120 moved the production
# deploy off `fly-deploy.yml` — it lived in a composite action the deploy left
# behind, so deploying from there skipped it silently while promote.mjs's
# summary went on claiming a checkpoint had been taken.
#
# ⚠️ THIS is why [D-157] routes the workflow through a script rather than
# re-typing the steps: the last time these steps existed in two places, the
# copy that got re-typed was the one missing the checkpoint. Fail-closed and it
# must stay that way — no credential, no checkpoint, no migration. A migration
# is exactly the thing you cannot undo by redeploying the previous image.
#
# Preview is deliberately NOT checkpointed: that branch is disposable and
# re-seedable.
if [ "$ENVIRONMENT" = "production" ]; then
  # neon-checkpoint.sh authenticates neonctl itself — its own stored credential
  # from `neonctl auth`, or an explicit NEON_API_KEY if one is exported
  # (ensure_neon_auth in infra/database/scripts/_common.sh).
  #
  # This used to read the key from Infisical's `infra` environment on every
  # production deploy. That coupling broke a deploy for real on 2026-08-31: the
  # Neon API keys were deleted, the checkpoint fail-closed as designed, and
  # `production` was left fast-forwarded with the app still on the previous
  # release.
  #
  # The fail-closed shape is UNCHANGED and must stay: no checkpoint, no
  # migration. Only the credential moved; the refusal did not.
  #
  # Belt and braces: the checkpoint runs in a child process, so a NEON_API_KEY
  # set in this shell but never exported would not reach it.
  [ -z "${NEON_API_KEY:-}" ] || export NEON_API_KEY

  # Supplied as the `NEON_PROJECT_ID` environment SECRET, which
  # deploy-production.yml passes through ([D-157]), or exported by hand for a
  # laptop run: `NEON_PROJECT_ID=$(neonctl projects list) …`.
  #
  # ⚠️ NO DEFAULT, and this is deliberate. It used to fall back to the
  # production project id written out in full. That is not free in a PUBLIC
  # repository: a Neon project id names the exact project holding real student
  # data, which is the reconnaissance surface [D-158] exists to remove. Same
  # posture as `LIVEKIT_ORIGIN_IP` in scripts/local/synthetic.sh: refuse rather
  # than guess.
  #
  # Failing here is safe — this is BEFORE the checkpoint and before migrations,
  # so a missing value costs a re-run, not a half-migrated production.
  if [ -z "${NEON_PROJECT_ID:-}" ]; then
    echo "database-deploy: NEON_PROJECT_ID is unset — the pre-migration Neon checkpoint cannot run." >&2
    echo "  Set the NEON_PROJECT_ID environment secret, or export it for this run." >&2
    echo "  Find it with: neonctl projects list" >&2
    exit 2
  fi
  export NEON_PROJECT_ID

  echo "› Checkpointing the Neon production branch before migrations…"
  # No --keep: the retention number lives once, in neon-checkpoint.sh's own
  # KEEP (pinned by apps/web/tests/config/neon-checkpoint-retention.test.ts) —
  # passing it here would be a second copy to keep in lockstep. --yes because
  # pruning is routine and this runs unattended.
  bash infra/database/scripts/neon-checkpoint.sh --parent production --label "$SHA" --yes
fi

# ── 2. Migrations ────────────────────────────────────────────────────────
# Fail-closed: refuse to deploy code against a schema it may not match rather
# than silently skip. D-72 is the reason — preview had no migrate step, the
# deploy shipped code that read a new column, the Neon branch never got it, and
# every teacher read (sign-in included) started 500ing behind a green deploy.
echo "› Applying pending Prisma migrations to ${ENVIRONMENT}…"
pnpm install --frozen-lockfile --filter spiralclass-web...
DATABASE_URL="$DATABASE_URL" DIRECT_URL="$DIRECT_URL" \
  pnpm --filter spiralclass-web exec tsx scripts/migrate-regions.ts

echo "› ${ENVIRONMENT} is migrated to ${SHA}."
