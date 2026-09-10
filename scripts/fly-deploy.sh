#!/usr/bin/env bash
# The web deploy — the ONE copy of it, run from two places.
#
# It was .github/workflows/fly-deploy.yml's deploy jobs until D-120 moved it
# here and D-129 deleted the workflow. [D-157] puts Actions back in front of it
# WITHOUT copying it back into YAML: .github/workflows/deploy-preview.yml and
# deploy-production.yml both invoke this script, for the same reason the gate
# workflow invokes scripts/ci/gate.mjs. Seven ordered steps re-typed as YAML is
# two deploys that agree until the day they do not, and step 1 of these seven
# is the checkpoint that makes a bad migration recoverable.
#
# Also still run by hand, to deploy without waiting on/pushing to
# `main`/`production` (e.g. to test a Fly/Docker change before it's committed).
# Environment-agnostic: pass `preview` (default) or `production` as the first
# argument. The steps, in an order that is load-bearing:
#
#   1. (production only) checkpoint the Neon `production` branch, so a bad
#      migration has a named restore point (D-95)
#   2. apply pending Prisma migrations to the target Neon branch
#   3. build apps/web's amd64 image via docker buildx
#      (Fly's bundled Depot builder is unreliable — see the build section below)
#   4. push it to registry.fly.io
#   5. `flyctl deploy --image` it
#   6. record the deploy in the local release ledger (.gate/release.json)
#   7. sync Inngest function definitions against the freshly deployed app
#
# ARCHITECTURE, and why running this on a runner is the point of [D-157]. Fly
# runs amd64 images only. On the operator's arm64 Mac step 3 is a QEMU
# cross-build: 20-30+ minutes, and flaky with threaded native addons. On
# `ubuntu-latest` it is a native build with no emulation at all. That is a
# bigger argument for moving the deploy than the Actions bill ever was.
#
# CREDENTIALS. Since [D-163] there is ONE store — Infisical's environment of
# the same name — and the two callers differ only in how they authenticate to
# it. Neither holds a copy of anything:
#
#   * The RUNNER reads them from the `production` GitHub Environment, which
#     Infisical syncs into. It holds no credential for Infisical at all, and
#     that is deliberate rather than incidental — see [D-163]'s addendum, which
#     reversed the machine identity it originally shipped because a job that
#     can mint a token for the vault hands that capability to every step in it,
#     `pnpm install` included.
#   * The LAPTOP authenticates with the operator's own `infisical login`. Run
#     this script under it and every branch below takes the same path the
#     runner takes:
#
#       infra/infisical/run.sh production ./scripts/fly-deploy.sh production \
#         --yes-i-understand-this-skips-the-promote-gate
#
#     ⚠️ Run BARE and the __LOCAL__ build args have nowhere to come from, since
#     [D-163] deleted the `config/env/*.local.env` overlays. That is not a
#     regression to work around by recreating one: the overlay was the copy
#     nobody rotates, which is the argument infra/infisical/run.sh's own header
#     already makes.
#
# Both are read env-first, and that is what makes one script serve both:
#
#   * Fly. `flyctl` reads FLY_API_TOKEN natively, so an exported token wins
#     over any `flyctl auth login` session without this script branching.
#   * DATABASE_URL / DIRECT_URL. If BOTH are already in the environment they
#     are used as-is. Otherwise this script shells out to the Infisical CLI
#     itself — the path a bare laptop run still takes.
#   * The __LOCAL__ BUILD args. scripts/env-config.mjs resolves those from the
#     process environment, throwing and naming every key it cannot satisfy —
#     so a misconfigured caller fails loudly instead of baking a broken client
#     bundle into an image that deploys green.
#
# `production` is normally only reached AFTER `pnpm promote`'s full gate
# (checks + integration + E2E) fast-forwards the `production` branch — see
# CLAUDE.md's Development workflow section. Deploying production from here
# skips that gate entirely, so it refuses to run against production unless
# you pass --yes-i-understand-this-skips-the-promote-gate too.
#
# Requires: flyctl, docker (with buildx), python3, pnpm — plus infisical
# (logged in, linked via infra/infisical/.infisical.json) ONLY when the
# database URLs are not already in the environment. Production additionally
# needs npx and a neonctl that can authenticate for the pre-migration
# checkpoint — `neonctl auth` once per machine, or NEON_API_KEY — and
# NEON_PROJECT_ID, which has no default and must be supplied (see below).
#
# Usage:
#   ./scripts/fly-deploy.sh                # preview (default)
#   ./scripts/fly-deploy.sh preview
#   ./scripts/fly-deploy.sh production --gate-already-passed   # what `pnpm promote` and deploy-production.yml call
#   ./scripts/fly-deploy.sh production --yes-i-understand-this-skips-the-promote-gate

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENVIRONMENT="${1:-preview}"
case "$ENVIRONMENT" in
preview) CONFIG=fly.preview.toml ;;
production)
  CONFIG=fly.production.toml
  # Two ways to reach production. `--gate-already-passed` is what
  # scripts/ci/promote.mjs passes after it has just run the full tier and
  # fast-forwarded the branch — that is the NORMAL path as of D-120, since the
  # deploy is chained into promote rather than triggered by the push. The
  # louder flag is for a human deploying production outside that flow, where
  # the gate genuinely has not run and saying so out loud is the point.
  if [ "${2:-}" != "--gate-already-passed" ] &&
    [ "${2:-}" != "--yes-i-understand-this-skips-the-promote-gate" ]; then
    echo "Refusing to deploy production from a local script without the full promote gate (checks + integration + E2E)." >&2
    echo "Normal path: pnpm promote — it runs the gate, fast-forwards production, and calls this script for you." >&2
    echo "If you really mean to bypass that here, re-run with: production --yes-i-understand-this-skips-the-promote-gate" >&2
    exit 1
  fi
  ;;
*)
  echo "usage: $0 [preview|production] [--gate-already-passed|--yes-i-understand-this-skips-the-promote-gate]" >&2
  exit 1
  ;;
esac

command -v flyctl >/dev/null || { echo "install flyctl: https://fly.io/install.sh" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required (with buildx)" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

# Infisical is only a dependency of the path that actually reads from it. A
# runner supplies DATABASE_URL/DIRECT_URL as environment secrets and has no
# Infisical login; demanding the CLI there would be demanding a tool for a
# branch that is never taken. Both must be present — one alone is a
# half-configured environment, and silently falling back to Infisical for the
# other half is how you migrate one database and deploy against the other.
# ⚠️ THIS SCRIPT NO LONGER READS INFISICAL, and [D-163] is why rather than
# [D-169]. Its own text says the laptop reads these values "through
# `infra/infisical/run.sh production ./scripts/fly-deploy.sh …` rather than
# from a file that is the copy nobody rotates" — the composition is the
# supported path, and the branch that used to be here was a second one nobody
# removed. CI already invokes this with both values in the environment.
#
#   from a laptop:  infra/infisical/run.sh preview scripts/fly-deploy.sh preview
#
[ -n "${DATABASE_URL:-}" ] && [ -n "${DIRECT_URL:-}" ] || {
  echo "DATABASE_URL and DIRECT_URL must both be in the environment." >&2
  echo "From a laptop, compose with the wrapper rather than reaching for the CLI here:" >&2
  echo "  infra/infisical/run.sh ${ENVIRONMENT:-preview} scripts/fly-deploy.sh ${ENVIRONMENT:-preview}" >&2
  exit 1
}

# `app` lives in the fly config itself — reading it here means this script
# never needs its own preview/production app-name table to keep in sync with
# those files.
APP="$(python3 -c "import tomllib,sys; print(tomllib.load(open(sys.argv[1],'rb'))['app'])" "$CONFIG")"

# The public hostname isn't a fly.toml field — preview.spiralclass.com /
# spiralclass.com is DNS convention, matching the workflow's per-job
# hardcoded URLs.
case "$ENVIRONMENT" in
preview) INNGEST_URL="https://preview.spiralclass.com/api/inngest" ;;
production) INNGEST_URL="https://spiralclass.com/api/inngest" ;;
esac

SHA="$(git rev-parse HEAD)"
IMAGE="registry.fly.io/${APP}:${SHA}"

# ── 1. Neon checkpoint (production only) ─────────────────────────────────
# The pre-migration restore point D-95 made production's primary safety net,
# and the one step that did NOT come along when D-120 moved the production
# deploy off `fly-deploy.yml` — it lived in a composite action the deploy left
# behind, so deploying from here skipped it silently while promote.mjs's
# summary went on claiming a checkpoint had been taken.
#
# ⚠️ THIS is why [D-157] routes the workflow through this script rather than
# re-typing the seven steps: the last time these steps existed in two places,
# the copy that got re-typed was the one missing the checkpoint. Fail-closed
# and it must stay that way — no credential, no checkpoint, no deploy. A
# migration is exactly the thing you cannot undo by redeploying the previous
# image.
#
# Preview is deliberately NOT checkpointed: that branch is disposable and
# re-seedable.
if [ "$ENVIRONMENT" = "production" ]; then
  # No NEON_API_KEY is fetched here any more. neon-checkpoint.sh authenticates
  # neonctl itself — its own stored credential from `neonctl auth`, or an
  # explicit NEON_API_KEY if one happens to be exported (ensure_neon_auth in
  # infra/database/scripts/_common.sh).
  #
  # This used to read the key from Infisical's `infra` environment on every
  # production deploy. That coupling broke a deploy for real on 2026-08-31: the
  # Neon API keys were deleted, the checkpoint fail-closed as designed, and
  # `production` was left fast-forwarded with the app still on the previous
  # release. Since this laptop is the only thing that deploys (D-129), a
  # machine-local credential loses nothing that was in use, and removes a secret
  # that has to exist, be valid and be rotated for a deploy to work at all.
  #
  # The fail-closed shape is UNCHANGED and must stay: no checkpoint, no deploy.
  # A migration is the one thing redeploying the previous image cannot undo.
  # Only the credential moved; the refusal did not.
  #
  # Belt and braces: the checkpoint runs in a child process, so a NEON_API_KEY
  # set in this shell but never exported would not reach it.
  [ -z "${NEON_API_KEY:-}" ] || export NEON_API_KEY

  # Supplied as the `NEON_PROJECT_ID` environment SECRET, which
  # deploy-production.yml passes through ([D-157]), or exported by hand for a
  # laptop deploy: `NEON_PROJECT_ID=$(neonctl projects list) …`. It was a
  # repository variable until 2026-09-10; the reasoning below is what moved it,
  # and it applies to a plaintext run log as much as to this file ([D-163]'s
  # second addendum).
  #
  # ⚠️ NO DEFAULT, and this is deliberate. It used to fall back to the
  # production project id written out in full right here — not a credential, so
  # it read as free zero-config. It is not free in a PUBLIC repository: a Neon
  # project id names the exact project holding real student data, which is the
  # reconnaissance surface [D-158] exists to remove, and the file it was
  # "already in" published it too. Same posture as `LIVEKIT_ORIGIN_IP` in
  # scripts/local/synthetic.sh: refuse rather than guess.
  #
  # Failing here is safe — this is BEFORE the checkpoint and before migrations,
  # so a missing value costs a re-run, not a half-deployed production.
  if [ -z "${NEON_PROJECT_ID:-}" ]; then
    echo "fly-deploy: NEON_PROJECT_ID is unset — the pre-migration Neon checkpoint cannot run." >&2
    echo "  Set the NEON_PROJECT_ID environment secret, or export it for this run." >&2
    echo "  Find it with: neonctl projects list" >&2
    exit 2
  fi
  export NEON_PROJECT_ID

  echo "› Checkpointing the Neon production branch before migrations…"
  # No --keep: the retention number lives once, in neon-checkpoint.sh's own
  # KEEP (pinned against the action's default by
  # apps/web/tests/config/neon-checkpoint-retention.test.ts) — passing it here
  # would be a third copy to keep in lockstep. --yes because pruning is routine
  # and this runs unattended inside `pnpm promote`.
  bash infra/database/scripts/neon-checkpoint.sh --parent production --label "$SHA" --yes
fi

# ── 2. Migrations ────────────────────────────────────────────────────────
# Fail-closed: refuse to deploy code against a schema it may not match rather
# than silently skip. D-72 is the reason — preview had no migrate step, this
# shipped the code that read a new column, the Neon branch never got it, and
# every teacher read (sign-in included) started 500ing behind a green deploy.
echo "› Using the ${ENVIRONMENT} DATABASE_URL/DIRECT_URL from the environment…"

if [ -z "$DATABASE_URL" ] || [ -z "$DIRECT_URL" ]; then
  echo "No DATABASE_URL/DIRECT_URL for env=${ENVIRONMENT} — aborting rather than deploy against an unmigrated schema." >&2
  exit 1
fi

echo "› Applying pending Prisma migrations to ${ENVIRONMENT}…"
pnpm install --frozen-lockfile --filter spiralclass-web...
DATABASE_URL="$DATABASE_URL" DIRECT_URL="$DIRECT_URL" \
  pnpm --filter spiralclass-web exec tsx scripts/migrate-regions.ts

# ── 3/4. Build (amd64) and push ─────────────────────────────────────────
echo "› Collecting NEXT_PUBLIC_* build args from config/env/${ENVIRONMENT}.build.env…"
# Runtime preflight. The build half fails on its own — env-build-args.mjs
# throws on an unsatisfied __LOCAL__ (scripts/env-config.mjs). The RUNTIME half
# cannot: docker-entrypoint.sh deliberately leaves a __LOCAL__ unset so the app
# degrades cleanly rather than pointing at a project that does not exist, which
# means a missing Fly secret would deploy quietly and break sign-in or checkout
# with nothing red. So check here, where it is still cheap.
RUNTIME_FILE="config/env/${ENVIRONMENT}.runtime.env"

# Listed ONCE, and the failure to list is distinguished from an empty list.
#
# This used to run `flyctl secrets list … 2>/dev/null` inside the loop, which
# meant a credential that could not list — the case a CI runner introduces,
# where the token is deploy-scoped rather than a full session — reported EVERY
# key as missing and aborted with a message naming secrets that are in fact
# set. A preflight that cannot tell "absent" from "could not look" is worse
# than no preflight: it sends you to fix the wrong thing.
if ! FLY_SECRETS="$(flyctl secrets list --app "$APP" 2>&1)"; then
  echo "" >&2
  echo "  Could not list $APP's secrets, so this deploy cannot check whether the" >&2
  echo "  __LOCAL__ runtime values are set. flyctl said:" >&2
  echo "" >&2
  printf '    %s\n' "$FLY_SECRETS" >&2
  echo "" >&2
  echo "  Refusing to continue: booting with those unset breaks sign-in or checkout" >&2
  echo "  with nothing red, which is exactly what this check exists to prevent." >&2
  echo "" >&2
  exit 1
fi

MISSING=""
while IFS= read -r line; do
  case "$line" in "" | \#*) continue ;; esac
  key="${line%%=*}"
  [ "${line#*=}" = "__LOCAL__" ] || continue
  # `secrets list` marks a STAGED secret with a leading "* ", so the name is
  # $2 on those rows and $1 on deployed ones. Staged counts: it is exactly the
  # state a secret is in between being set and the deploy that consumes it,
  # which is this script.
  if ! printf '%s\n' "$FLY_SECRETS" |
    awk '{ if ($1 == "*") print $2; else print $1 }' | grep -qx "$key"; then
    MISSING="$MISSING $key"
  fi
done < "$RUNTIME_FILE"
if [ -n "$MISSING" ]; then
  echo "" >&2
  echo "  $RUNTIME_FILE marks these __LOCAL__, and $APP has no secret for them:" >&2
  for k in $MISSING; do echo "    $k" >&2; done
  echo "" >&2
  echo "  Deploying now would boot with them unset. Set them first:" >&2
  echo "    flyctl secrets set --app $APP --stage KEY=value ..." >&2
  echo "  The real values are in Infisical's \`${ENVIRONMENT}\` environment (D-163)." >&2
  echo "" >&2
  exit 1
fi

BUILD_ARGS_OUT="$(node scripts/env-build-args.mjs "$ENVIRONMENT")"
BUILD_ARGS_BLOCK="$(echo "$BUILD_ARGS_OUT" | sed -n '/^build_args<</,/^__FLY_BUILD_ARGS_EOF__$/p' | sed '1d;$d')"

BUILD_ARG_FLAGS=()
while IFS= read -r line; do
  [ -n "$line" ] && BUILD_ARG_FLAGS+=(--build-arg "$line")
done <<<"$BUILD_ARGS_BLOCK"

# The per-deploy identifier for Next's `?dpl=` version-skew mitigation. It is
# NOT sourced from config/env/<env>.build.env like the args above, and cannot
# be: that file is static, and this value must differ on every deploy for Next
# to tell an old client from a current one. The commit SHA does, and $SHA is
# already the image tag, so the id and the image agree by construction.
#
# next.config.ts has read NEXT_DEPLOYMENT_ID all along and asked for exactly
# this; nothing ever supplied it, so `deploymentId` was undefined on every
# image and no `?dpl=` was stamped. Appending it to BUILD_ARG_FLAGS rather than
# to either `docker buildx build` below is deliberate — both invocations must
# be passed byte-identical args or the second stops being the pure cache hit
# the push race depends on (see the comment above it).
BUILD_ARG_FLAGS+=(--build-arg "NEXT_DEPLOYMENT_ID=${SHA}")

# WHY THIS IS TWO INVOCATIONS AND NOT ONE `--push` BUILD.
#
# `flyctl auth docker` mints a registry credential lasting only ~5-6 minutes,
# so a single `buildx build --push` RACES that token: it is minted before the
# build and used at the very end of it. When the build wins the race the push
# fails with `unknown: app repository not found` — Fly's registry reports an
# expired credential as a missing repository, so it reads as a misconfiguration
# rather than the timeout it is. (2026-08-30: a 565s build failed exactly this
# way and left three merged PRs deployed nowhere; a 102s build through this
# same script had pushed fine an hour earlier. The only difference was build
# duration.)
#
# So build FIRST without pushing, and authenticate once the slow part is done.
# The second invocation is the first plus `--push`, so every layer is a cache
# hit and the push begins seconds after the token is minted. Do NOT collapse
# these back into one `--push` build — that is the bug, not a tidy-up.
#
# The race is narrower on a runner ([D-157]: a native amd64 build, no QEMU)
# than on the arm64 Mac that produced the incident, but "narrower" is the
# reason the bug was invisible for months. The shape stays.
#
# BUILDX_CACHE_FROM / BUILDX_CACHE_TO are an env-driven hook for a layer cache,
# empty by default. They are here rather than in the workflow for the same
# reason everything else is: a `--cache-from` that only exists in YAML makes
# the runner's build a different build from the one you can reproduce locally.
# Nothing sets them yet — see [D-157]'s "what is deliberately not done".
BUILDX_CACHE_FLAGS=()
[ -z "${BUILDX_CACHE_FROM:-}" ] || BUILDX_CACHE_FLAGS+=(--cache-from "$BUILDX_CACHE_FROM")
[ -z "${BUILDX_CACHE_TO:-}" ] || BUILDX_CACHE_FLAGS+=(--cache-to "$BUILDX_CACHE_TO")

echo "› Building ${IMAGE} (linux/amd64, on $(uname -m))…"
docker buildx build \
  --platform linux/amd64 \
  -t "$IMAGE" \
  "${BUILD_ARG_FLAGS[@]}" \
  "${BUILDX_CACHE_FLAGS[@]+"${BUILDX_CACHE_FLAGS[@]}"}" \
  .

echo "› Authenticating to registry.fly.io/${APP}…"
flyctl auth docker

echo "› Pushing ${IMAGE} (layers already built — this is a cache hit)…"
docker buildx build \
  --platform linux/amd64 \
  --push \
  -t "$IMAGE" \
  "${BUILD_ARG_FLAGS[@]}" \
  "${BUILDX_CACHE_FLAGS[@]+"${BUILDX_CACHE_FLAGS[@]}"}" \
  .

# ── 5. Deploy ────────────────────────────────────────────────────────────
echo "› Deploying ${IMAGE} to ${APP}…"
flyctl deploy -c "$CONFIG" -a "$APP" --image "$IMAGE"

# ── 6. Release ledger ────────────────────────────────────────────────────
# Records that THIS environment is now serving THIS commit (scripts/ci/lib.mjs).
# Written here rather than in promote.mjs so a hand-run deploy — the recovery
# path when a promote's build fails after the fast-forward — updates it too.
# Before the Inngest sync because that call `exec`s and never returns.
echo "› Recording the deploy in the release ledger…"
node scripts/ci/record-release.mjs --kind web-deploy --env "$ENVIRONMENT" --sha "$SHA" || true

# ── 7. Inngest sync ──────────────────────────────────────────────────────
# Same retry loop the CI deploy jobs use — the one copy lives in
# scripts/inngest-sync.sh — one copy, so preview, production and a hand-run
# deploy cannot drift on it. We cd'd to the repo root at the top, so this
# relative path resolves correctly.
echo "› Syncing Inngest functions (${ENVIRONMENT})…"
exec bash scripts/inngest-sync.sh "$INNGEST_URL"
