#!/bin/sh
# Fly/Docker container entrypoint. Sources the non-secret RUNTIME config for
# this environment (config/env/<APP_ENV>.runtime.env, D-85) into the process
# env, then execs the server. This is the runtime half of moving non-secret
# config out of fly.<env>.toml's [env] into git-versioned, platform-neutral
# files — the build half (NEXT_PUBLIC_*) is baked in at image build time via
# scripts/env-build-args.mjs.
#
# POSIX sh (node:24-slim ships dash as /bin/sh, not bash). Keep this loop in
# lockstep with the grammar documented in config/env/README.md and enforced by
# scripts/env-config.mjs: `KEY=value`, one per line; whole-line `#` comments;
# blank lines skipped; values unquoted; empty value (`KEY=`) preserved.
set -eu

env_file="config/env/${APP_ENV:-}.runtime.env"

if [ -z "${APP_ENV:-}" ]; then
  # Back-compat / misconfig: boot without the file rather than crash-loop, but
  # say so loudly — the app falls back to each var's code-level default.
  echo "docker-entrypoint: APP_ENV unset — not sourcing any config/env file" >&2
elif [ ! -f "$env_file" ]; then
  # APP_ENV was set but the file is missing: that is a real misconfiguration
  # (typo'd APP_ENV, or the file wasn't COPYed into the image). Fail loudly.
  echo "docker-entrypoint: APP_ENV=$APP_ENV but $env_file not found" >&2
  exit 1
else
  echo "docker-entrypoint: sourcing non-secret config from $env_file" >&2
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip blank lines and whole-line comments.
    case "$line" in
      "" | \#*) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    # Container env wins over the committed default: an Infisical secret or a
    # `fly secrets set` override for the same key (e.g. an emergency CSP toggle)
    # must not be clobbered by the file. `${key}` may be unset, hence the guard.
    # A __LOCAL__ placeholder means the real value deliberately is not in git
    # (config/env/README.md). Exporting it would point production at something
    # that does not exist; leaving it unset lets env.ts apply the var's own
    # absent-value behaviour, which degrades the feature cleanly instead.
    eval "current=\${$key-__ENTRYPOINT_UNSET__}"
    if [ "$value" = "__LOCAL__" ]; then
      # Only warn when the value really is missing. This branch used to warn
      # unconditionally, including for keys the container env HAD supplied, so
      # every boot printed all nine lines and the warning could not tell a
      # configured box from a broken one. On Fly that never mattered — a
      # __LOCAL__ with no matching secret is refused before the deploy by
      # scripts/fly-deploy.sh's preflight. Off Fly there is no preflight
      # (D-150), so this line is the only boot-time signal there is.
      if [ "$current" = "__ENTRYPOINT_UNSET__" ]; then
        echo "docker-entrypoint: $key is __LOCAL__ and no override was supplied — leaving it unset" >&2
      fi
      continue
    fi
    if [ "$current" = "__ENTRYPOINT_UNSET__" ]; then
      export "$key=$value"
    fi
  done < "$env_file"
fi

# ── The SECRET half, for hosts that deliver secrets as a file ([D-184]) ─────
#
# On Fly the secrets arrive as container environment variables (`fly secrets`),
# so SECRETS_ENV_FILE is unset there and this whole block is skipped — Fly's
# boot is byte-for-byte what it was.
#
# Cloud Run mounts a Secret Manager secret as a file instead, and does it that
# way for two reasons that are worth stating. Secret Manager's free tier is six
# active versions and this app has ~18 secrets, so eighteen separate secrets
# would cost $0.72/month — against a migration whose whole prize is ~$7/month.
# One secret holding the whole set is free. And a mounted secret means the
# deploy identity never needs `secretAccessor`: CI can ship an image and still
# cannot read a Stripe key, which is the boundary the per-job credential split
# already draws everywhere else in this repository.
#
# Same grammar as above (config/env/README.md) and the same precedence rule:
# a value already in the container environment wins, so a one-off override set
# on the service is not clobbered by the file.
#
# ⚠️ A path that is named but absent is fatal. A missing mount means the secrets
# did not arrive, and booting without DATABASE_URL would fail Zod's parse at the
# first request instead — a 503 loop that says nothing about why.
if [ -n "${SECRETS_ENV_FILE:-}" ]; then
  if [ ! -f "$SECRETS_ENV_FILE" ]; then
    echo "docker-entrypoint: SECRETS_ENV_FILE=$SECRETS_ENV_FILE is set but not present" >&2
    exit 1
  fi
  echo "docker-entrypoint: sourcing secrets from $SECRETS_ENV_FILE" >&2
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "" | \#*) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    eval "current=\${$key-__ENTRYPOINT_UNSET__}"
    if [ "$current" = "__ENTRYPOINT_UNSET__" ]; then
      export "$key=$value"
    fi
  done < "$SECRETS_ENV_FILE"
fi

exec "$@"
