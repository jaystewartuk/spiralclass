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
#      — steps 1 and 2 are scripts/database-deploy.sh, which this runs first
#        UNLESS passed --database-already-deployed. deploy-production.yml passes
#        it, because its `database` job already ran that script for this commit
#        and this job `needs:` that one ([D-177]'s addendum). A hand run passes
#        nothing, and checkpoints and migrates exactly as it always has.
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
#   * DATABASE_URL / DIRECT_URL. Read only by scripts/database-deploy.sh,
#     which requires both in the environment and refuses otherwise.
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
# Requires: flyctl, docker (with buildx), python3 and FLY_API_TOKEN (or a
# `flyctl auth login` session). Unless --database-already-deployed is passed,
# also everything scripts/database-deploy.sh requires: pnpm, DATABASE_URL and
# DIRECT_URL, and for production npx, a neonctl that can authenticate and
# NEON_PROJECT_ID. With the flag, this script holds no database credential at
# all — which is what lets the workflow's Fly job hold none.
#
# Usage:
#   ./scripts/fly-deploy.sh                # preview (default)
#   ./scripts/fly-deploy.sh preview
#   ./scripts/fly-deploy.sh production --gate-already-passed   # a recovery deploy: checkpoints and migrates first
#   ./scripts/fly-deploy.sh production --gate-already-passed --database-already-deployed   # what deploy-production.yml calls
#   ./scripts/fly-deploy.sh production --yes-i-understand-this-skips-the-promote-gate

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

USAGE="usage: $0 [preview|production] [--gate-already-passed|--yes-i-understand-this-skips-the-promote-gate] [--database-already-deployed]"

ENVIRONMENT="${1:-preview}"
[ "$#" -eq 0 ] || shift

# Flags in any order, and anything unrecognised is refused rather than ignored:
# a misspelt --database-already-deployed must not quietly mean "run the
# migrations after all" on the one job that holds no database credential.
GATE_FLAG=""
DATABASE_ALREADY_DEPLOYED=0
for arg in "$@"; do
  case "$arg" in
  --gate-already-passed | --yes-i-understand-this-skips-the-promote-gate) GATE_FLAG="$arg" ;;
  --database-already-deployed) DATABASE_ALREADY_DEPLOYED=1 ;;
  *)
    echo "$USAGE" >&2
    exit 1
    ;;
  esac
done

case "$ENVIRONMENT" in
preview) CONFIG=fly.preview.toml ;;
production)
  CONFIG=fly.production.toml
  # Two ways to reach production. `--gate-already-passed` is what
  # deploy-production.yml passes, after `pnpm promote` ran the full tier and
  # fast-forwarded the branch. The louder flag is for a human deploying
  # production outside that flow, where the gate genuinely has not run and
  # saying so out loud is the point.
  if [ -z "$GATE_FLAG" ]; then
    echo "Refusing to deploy production from a local script without the full promote gate (checks + integration + E2E)." >&2
    echo "Normal path: pnpm promote — it runs the gate, fast-forwards production, and deploy-production.yml calls this for you." >&2
    echo "If you really mean to bypass that here, re-run with: production --yes-i-understand-this-skips-the-promote-gate" >&2
    exit 1
  fi
  ;;
*)
  echo "$USAGE" >&2
  exit 1
  ;;
esac

command -v flyctl >/dev/null || { echo "install flyctl: https://fly.io/install.sh" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required (with buildx)" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

# ⚠️ THIS SCRIPT DOES NOT READ INFISICAL, and [D-163] is why rather than
# [D-169]. Its own text says the laptop reads these values "through
# `infra/infisical/run.sh production ./scripts/fly-deploy.sh …` rather than
# from a file that is the copy nobody rotates" — the composition is the
# supported path. The DATABASE_URL/DIRECT_URL check that used to sit here moved
# with the steps that need them, into scripts/database-deploy.sh, and runs
# before that script touches anything.
#
#   from a laptop:  infra/infisical/run.sh preview scripts/fly-deploy.sh preview

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

# ── 1/2. Checkpoint and migrate — scripts/database-deploy.sh ─────────────
# Fail-closed, and before anything is built: code must never reach a schema it
# may not match (D-72 — a deploy shipped code reading a new column, the branch
# never got it, and every teacher read 500ed behind a green deploy).
#
# The steps live in their own script because the database is not Fly's. Both
# production targets serve the same Neon branch, so the checkpoint and the
# migrations belong to the commit, not to whichever platform deploys it — and
# while they sat inside this file, the Vercel failover could only deploy after
# a Fly deploy had succeeded ([D-177]'s addendum).
#
# ⚠️ --database-already-deployed is a claim, not a check: this script cannot
# verify it, and with it this job holds no database credential to verify with.
# It is honest in exactly one place — deploy-production.yml's Fly job, which
# `needs:` the `database` job that ran the script for this commit, and
# apps/web/tests/config/production-targets.test.ts asserts that is the only
# caller. Passed by hand against a commit whose migrations have not run, it
# deploys code ahead of its schema.
if [ "$DATABASE_ALREADY_DEPLOYED" = 1 ]; then
  echo "› Skipping the checkpoint and migrations: --database-already-deployed (the workflow's database job ran them)."
else
  bash scripts/database-deploy.sh "$ENVIRONMENT" ${GATE_FLAG:+"$GATE_FLAG"}
fi

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
