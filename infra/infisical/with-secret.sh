#!/usr/bin/env bash
# Pull named secret(s) into the CALLING shell's environment. SOURCE this, never
# exec it. It resolves everything relative to ITSELF, so a script using it does
# not need to live in infra/infisical/.
#
# Since [D-169] this is a thin adapter over infra/infisical/infisical.sh, which
# is the only file that runs the CLI. What is left here is the one thing a
# wrapper cannot do from a subprocess: export into the caller.
#
# Usage (after `source .../infra/infisical/with-secret.sh`):
#   infisical_export_secrets LIVEKIT_API_SECRET                # env=preview (default)
#   infisical_export_secrets --env production STRIPE_SECRET_KEY
#   infisical_export_secrets DATABASE_URL DIRECT_URL
#
# WHEN TO USE THIS vs. `infisical_exec` / `infra/infisical/run.sh`
# The two are not interchangeable, and neither replaces the other:
#
#   - `infisical run` injects into a SUBPROCESS. Reach for it when the consumer
#     is a single command and the secret set is a POLICY that should be able to
#     change without a code edit.
#   - THIS injects into the CALLING shell, which `run` cannot do. Reach for it
#     when a script needs the VALUE partway through its own body — one script
#     fetched at the top and did not use it until ~330 lines later, after
#     device resolution, flock and OTA settle. Wrapping that in a subprocess
#     would mean splitting every such script in two.
#
# Naming the secrets explicitly (rather than tagging) is the RIGHT call at
# these call sites: seed-preview.sh needs exactly DATABASE_URL and DIRECT_URL
# because seed.ts reads those two. That is a code dependency, not a policy —
# visible in the diff, and it cannot silently widen when someone adds a secret
# to a tag in the dashboard.
#
# ⚠️ THIS FILE NO LONGER SETS `set -euo pipefail`. It is sourced, so doing so
# changed the caller's shell for every line after it — an interactive terminal
# included. All six scripts that source this set their own options first, which
# is what made removing it safe rather than a guess.

# shellcheck source=./infisical.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/infisical.sh"

# Never falls through to a bare `export` on an empty or partial fetch: that
# dumps the ENTIRE shell environment, and leaked OPENAI_API_KEY (among others)
# into a terminal and a chat transcript the first time a script here shipped
# with a bad flag. infisical_secrets refuses both cases; this only exports.
infisical_export_secrets() {
  local env="preview"
  if [ "${1:-}" = "--env" ]; then
    env="$2"
    shift 2
  fi
  if [ "$#" -eq 0 ]; then
    echo "infisical_export_secrets: no secret names given" >&2
    return 1
  fi

  local secrets line
  secrets="$(infisical_secrets "$env" "$@")" || return 1
  while IFS= read -r line; do
    [ -n "$line" ] && export "$line"
  done <<< "$secrets"
}
