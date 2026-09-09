#!/usr/bin/env bash
# Prototype: the Ink (React for CLIs) live dashboard for LiveKit room
# activity, at packages/livekit-activity-cli. Same secret-pulling as its
# sibling livekit-activity.sh (`lk`/`watch`-based) — see that script's own
# comments for the full LIVEKIT_URL/preview-vs-production rationale — but
# execs into the Ink app instead of `lk room list` + `watch`, so the live
# loop is real React state updates, not a redrawn terminal frame from an
# external process.
#
# Requires: the Infisical CLI (installed + `infisical login`). Does NOT need
# the `lk` CLI or `watch` — packages/livekit-activity-cli talks to
# livekit-server-sdk directly.
#
# Usage:
#   ./docs/deployment/livekit-activity-ink.sh
#   ./docs/deployment/livekit-activity-ink.sh -- --interval-ms 5000
#   pnpm livekit:activity:ink
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"

ENV_FILE="$REPO_ROOT/config/env/preview.runtime.env"
LIVEKIT_URL="$(grep -E '^LIVEKIT_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
LIVEKIT_API_KEY="$(grep -E '^LIVEKIT_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)"

if [ -z "$LIVEKIT_URL" ] || [ -z "$LIVEKIT_API_KEY" ]; then
  echo "Couldn't read LIVEKIT_URL/LIVEKIT_API_KEY out of $ENV_FILE — aborting" >&2
  exit 1
fi

# shellcheck source=../../infra/infisical/with-secret.sh
source "$REPO_ROOT/infra/infisical/with-secret.sh"
infisical_export_secrets LIVEKIT_API_SECRET

(
  cd "$REPO_ROOT/packages/livekit-activity-cli"
  export LIVEKIT_URL LIVEKIT_API_KEY
  pnpm exec tsx src/cli.tsx "$@"
)
