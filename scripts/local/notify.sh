#!/usr/bin/env bash
# Failure alerting for the hand-run maintenance tasks (D-129).
#
#   bash scripts/local/notify.sh <urgent|high|default> "<title>" "<message>"
#
# Two channels on purpose. ntfy reaches the phone, which is what the deleted
# workflows used and the only channel that works once the operator has walked
# away from the machine; the macOS notification reaches the screen, which is
# where a hand-run task actually fails.
#
# FAILS OPEN, always. This is the alerting path — a missing NTFY secret must
# never turn "the backup failed" into "the notifier failed".
set -uo pipefail

URGENCY="${1:-default}"
TITLE="${2:-spiralclass}"
BODY="${3:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Desktop first: no secret, no network, no way to fail meaningfully.
if command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"${BODY//\"/\\\"}\" with title \"${TITLE//\"/\\\"}\"" \
    >/dev/null 2>&1 || true
fi

# Phone. Env wins; otherwise pull from Infisical, quietly — this runs on a path
# where a prompt or an error is worse than no push.
if [ -z "${NTFY_URL:-}" ] || [ -z "${NTFY_TOPIC:-}" ]; then
  if command -v infisical >/dev/null 2>&1; then
    # shellcheck source=/dev/null
    source "$REPO_ROOT/infra/infisical/with-secret.sh" 2>/dev/null || true
    infisical_export_secrets --env production NTFY_URL NTFY_TOPIC >/dev/null 2>&1 || true
  fi
fi

if [ -n "${NTFY_URL:-}" ] && [ -n "${NTFY_TOPIC:-}" ]; then
  curl -fsS \
    -H "Title: $TITLE" \
    -H "Priority: $URGENCY" \
    -H "Tags: rotating_light" \
    -d "$BODY" \
    "$NTFY_URL/$NTFY_TOPIC" >/dev/null 2>&1 || true
else
  echo "  (no NTFY_URL/NTFY_TOPIC — desktop notification only)" >&2
fi

exit 0
