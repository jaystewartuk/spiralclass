#!/usr/bin/env bash
# Prototype: the Ink (React for CLIs) live dashboard for LiveKit room
# activity, at packages/livekit-activity-cli. Same secret-pulling as its
# sibling livekit-activity.sh (`lk`/`watch`-based) — production's pair, and
# see that script's comments for why — but
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

# shellcheck source=./livekit-credentials.sh
source "$REPO_ROOT/docs/deployment/livekit-credentials.sh"

(
  cd "$REPO_ROOT/packages/livekit-activity-cli"
  pnpm exec tsx src/cli.tsx "$@"
)
