#!/usr/bin/env bash
# Show live LiveKit room/participant activity on the self-hosted box
# (docs/deployment/ORACLE_LIVEKIT_PRODUCTION.md) without ever writing
# LIVEKIT_API_SECRET to disk. Pulls it via infra/infisical/with-secret.sh's
# shared helper (same pattern every other Infisical-consuming task script
# uses — see that file's own header).
#
# ⚠️ Production's pair, because preview holds none (D-94's 2026-09-16
# addendum) — docs/deployment/livekit-credentials.sh reads it and says where
# from. The official `lk` CLI then talks to the server's API over LIVEKIT_URL,
# so no SSH is needed.
#
# Requires: the Infisical CLI (installed + `infisical login`), the LiveKit
# CLI (`lk`), and `watch` (util-linux, preinstalled on virtually every Linux
# box and via Homebrew on macOS) on PATH — https://github.com/livekit/livekit-cli.
#
# LIVE by default: refreshes the room table every 2s via `watch`, so the
# Infisical/`lk` auth round-trip happens ONCE up front, not once per tick.
# `--json` or `--once` skip the live loop and just print a single snapshot
# (e.g. for piping into `jq`) — anything else is forwarded straight through
# to `lk room list`.
#
# Usage:
#   ./docs/deployment/livekit-activity.sh              # live-refreshing table (default)
#   ./docs/deployment/livekit-activity.sh --interval 5 # live, custom refresh seconds
#   ./docs/deployment/livekit-activity.sh --once       # single human-table snapshot
#   ./docs/deployment/livekit-activity.sh --json       # single JSON snapshot (implies --once)
#   pnpm livekit:activity
#   pnpm livekit:activity -- --json | jq '[.[].numParticipants] | add // 0'
set -euo pipefail

WATCH_INTERVAL=2
ONCE=0
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --once) ONCE=1; shift ;;
    --json) ONCE=1; ARGS+=("$1"); shift ;;
    --interval)
      WATCH_INTERVAL="${2:?--interval needs a number of seconds}"
      shift 2
      ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
REPO_ROOT="$(git rev-parse --show-toplevel)"

command -v lk >/dev/null || { echo "install the LiveKit CLI: https://github.com/livekit/livekit-cli" >&2; exit 1; }
if [ "$ONCE" -eq 0 ]; then
  command -v watch >/dev/null || { echo "install 'watch' (util-linux/procps-ng), or pass --once/--json for a single snapshot" >&2; exit 1; }
fi

# shellcheck source=./livekit-credentials.sh
source "$REPO_ROOT/docs/deployment/livekit-credentials.sh"
if [ "$ONCE" -eq 1 ]; then
  lk room list ${ARGS[@]+"${ARGS[@]}"}
else
  # -x execs `lk` directly (no intermediate shell), so ARGS need no extra
  # quoting/escaping even if they contain spaces.
  watch -n "$WATCH_INTERVAL" -x lk room list ${ARGS[@]+"${ARGS[@]}"}
fi
