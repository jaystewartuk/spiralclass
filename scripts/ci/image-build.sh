#!/usr/bin/env bash
# Build the production image, and push it nowhere.
#
# WHY THIS EXISTS (#101). On 2026-09-13 the first production deploy from this
# repository found a Dockerfile that could not build (`corepack: not found`,
# #100) — and it found it from inside the deploy, after the `database` job had
# already checkpointed Neon and run `migrate deploy` against production. Gate
# and Heavy were both green on that commit, because neither of them ever built
# the image: the integration and browser suites run `next build` on a runner's
# own Node, never through the Dockerfile. So a change to the base image, its apt
# layer, the pnpm bootstrap or the standalone copy was first exercised by
# the production deploy, against production.
#
# This is the heavy-tier step that closes that (scripts/ci/steps.mjs). It is a
# script rather than a `run:` in heavy.yml for the reason every other suite is:
# the laptop and the runner must run the same thing, and a check that only
# exists in YAML is a second definition of green.
#
# WHAT IT BUILDS. The same build the deploy does, minus the parts that need
# credentials:
#
#   * The same Dockerfile, to its final stage (no --target), because that is
#     what scripts/cloudrun-deploy.sh builds. Naming a stage here would stop being
#     the deploy's build the day a stage is added after it.
#   * The same build args, resolved the same way: `node scripts/env-build-args.mjs
#     production`, over config/env/production.build.env. Every `__LOCAL__` key in
#     that file gets a STUB exported first, and the key list is read from the
#     file rather than typed here, so a key added there is stubbed here in the
#     same commit. The real values live in Infisical (D-163) and this build has
#     no business holding them — nothing it produces can reach a browser.
#   * NEXT_DEPLOYMENT_ID set to HEAD, as the deploy sets it.
#   * linux/amd64 by default, which is what Fly runs and what an ubuntu-latest
#     runner builds natively.
#
# WHAT IT NEVER DOES: push, tag for a registry, authenticate to one, or call
# gcloud. The output is `type=cacheonly` — BuildKit solves every stage, runs
# every RUN and every COPY, and then discards the result, so no image with stub
# values baked into its client bundle exists anywhere afterwards, not even in
# the local image store. apps/web/tests/config/local-gate.test.ts holds that.
#
# ON THE LAPTOP. Fly needs amd64 and this Mac is arm64, so the default is a
# cross-build under emulation: 20-30+ minutes where the builder can emulate at
# all, and colima's default builder cannot. Override the platform for a faster,
# weaker answer — it proves the Dockerfile builds, not that the amd64 layers do:
#
#   IMAGE_BUILD_PLATFORM=linux/arm64 bash scripts/ci/image-build.sh
#
# `pnpm promote` reads the runner's verdict for this step ([D-162]), so the
# amd64 answer that certifies a release comes from heavy.yml, not from here.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Serialize against every other checkout on this machine (D-146). An image
# build is the same `next build --turbopack` the other suites run — ~3.5GB peak
# with a 6GB heap ceiling — inside a container that competes for the same RAM.
# Passes straight through when the gate already holds the machine.
if [ "${SPIRALCLASS_LOCK_INNER:-}" != "1" ]; then
  exec env SPIRALCLASS_LOCK_INNER=1 \
    node scripts/ci/lock.mjs run --label "image-build" -- bash "$0" "$@"
fi

ENVIRONMENT=production
BUILD_ENV="config/env/${ENVIRONMENT}.build.env"
PLATFORM="${IMAGE_BUILD_PLATFORM:-linux/amd64}"

command -v docker >/dev/null || { echo "docker is required (with buildx)" >&2; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo "docker buildx is required" >&2; exit 1; }
[ -f "$BUILD_ENV" ] || { echo "$BUILD_ENV not found" >&2; exit 1; }

# ── Stub the __LOCAL__ build args ─────────────────────────────────────────
# Same line grammar scripts/env-config.mjs parses. Exported unconditionally, so a real
# value that happens to be in the caller's environment (a laptop shell under
# infra/infisical/run.sh) is overwritten rather than baked into a throwaway
# build: this step must give the same answer with or without credentials.
#
# URL-shaped for the *_URL keys, so a build-time consumer that parses one gets
# something parseable. `.invalid` is reserved (RFC 2606) and never resolves.
STUBBED=()
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in "" | \#*) continue ;; esac
  key="${line%%=*}"
  [ "${line#*=}" = "__LOCAL__" ] || continue
  case "$key" in
  *_URL) export "$key=https://image-build-stub.invalid" ;;
  *) export "$key=image-build-stub" ;;
  esac
  STUBBED+=("$key")
done <"$BUILD_ENV"
echo "› Stubbed ${#STUBBED[@]} __LOCAL__ build arg(s) from $BUILD_ENV: ${STUBBED[*]:-none}"

BUILD_ARGS_OUT="$(node scripts/env-build-args.mjs "$ENVIRONMENT")"
BUILD_ARGS_BLOCK="$(echo "$BUILD_ARGS_OUT" | sed -n '/^build_args<</,/^__FLY_BUILD_ARGS_EOF__$/p' | sed '1d;$d')"

BUILD_ARG_FLAGS=()
while IFS= read -r line; do
  [ -n "$line" ] && BUILD_ARG_FLAGS+=(--build-arg "$line")
done <<<"$BUILD_ARGS_BLOCK"
BUILD_ARG_FLAGS+=(--build-arg "NEXT_DEPLOYMENT_ID=$(git rev-parse HEAD)")

# ── Build ─────────────────────────────────────────────────────────────────
echo "› Building the production image (${PLATFORM}, on $(uname -m)); nothing is pushed or kept…"
docker buildx build \
  --platform "$PLATFORM" \
  --output type=cacheonly \
  --progress plain \
  ${BUILD_ARG_FLAGS[@]+"${BUILD_ARG_FLAGS[@]}"} \
  .

echo "› The production image builds."
