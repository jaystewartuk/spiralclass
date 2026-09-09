#!/bin/sh
# Assert that a running app container actually HAS its __LOCAL__ runtime values.
#
# ⚠️ THIS CHECK IS THE BOOT. scripts/docker-entrypoint.sh refuses to export a
# `__LOCAL__` placeholder, by design — so an app missing these starts cleanly,
# logs nothing wrong, and quietly loses sign-in (no Google client), checkout
# (no Stripe prices) and live classes (no LiveKit key). On Fly that could not
# happen, because fly-deploy.sh's preflight refused to deploy when a __LOCAL__
# key had no matching secret. There is no preflight here. Nothing else looks.
#
# Runs ON the box. Shipped by scripts/oracle-deploy.sh — POSIX sh, because it
# executes inside the app image, which is node:24-slim and has dash as /bin/sh.
#
#   ./verify-runtime-env.sh <container> [<container> ...]
set -eu

# ⚠️ THE KEY LIST IS READ OUT OF THE CONTAINER, NOT WRITTEN DOWN HERE.
#
# `config/env/<APP_ENV>.runtime.env` is baked into the image and is the same
# file scripts/docker-entrypoint.sh reads to decide what it refuses to export,
# so whatever it marks `__LOCAL__` is exactly the set that must be overridden.
# Deriving it means the check cannot drift from the definition.
#
# It used to be a hardcoded nine here AND a hardcoded nine in
# scripts/oracle-deploy.sh, with the real list in a third place. A tenth
# `__LOCAL__` added later would have been checked by neither, the deploy would
# have said "all nine present", and the tenth would have booted unset — which
# is the precise failure this script exists to catch, reintroduced by the
# script itself.

[ $# -gt 0 ] || { echo "usage: verify-runtime-env.sh <container>..." >&2; exit 2; }

rc=0
for container in "$@"; do
  if ! docker inspect "$container" >/dev/null 2>&1; then
    echo "MISSING CONTAINER: $container" >&2
    rc=1
    continue
  fi

  keys=$(docker exec "$container" sh -c \
    'grep "=__LOCAL__$" "config/env/${APP_ENV}.runtime.env" | cut -d= -f1' 2>/dev/null) || {
    echo "UNREACHABLE: $container (running?)" >&2
    rc=1
    continue
  }

  if [ -z "$keys" ]; then
    # Not "nothing to check". Either APP_ENV is unset or wrong, or the config
    # file is not in the image — and in both cases the entrypoint has already
    # failed to do its half.
    echo "FAIL: $container — could not read config/env/\$APP_ENV.runtime.env; APP_ENV is wrong or the file is missing" >&2
    rc=1
    continue
  fi

  n=$(printf '%s\n' "$keys" | grep -c .)

  missing=$(docker exec "$container" sh -c '
    for k in '"$keys"'; do
      v=$(printenv "$k" 2>/dev/null || true)
      case "${v:-UNSET}" in
        UNSET|__LOCAL__) printf "%s " "$k" ;;
      esac
    done
  ' 2>/dev/null) || {
    echo "UNREACHABLE: $container (running?)" >&2
    rc=1
    continue
  }

  if [ -z "$missing" ]; then
    echo "OK: $container — all $n present"
  else
    # ⚠️ Do not soften this into a warning. Every name printed here is a
    # feature that is already broken in a way no log will mention.
    echo "FAIL: $container — missing: $missing" >&2
    rc=1
  fi
done

exit $rc
