#!/usr/bin/env bash
# Single source of truth for the post-deploy Inngest sync.
#
# Inngest only re-reads function definitions (a new cron, a changed trigger)
# when something PUTs /api/inngest. Without this, a deploy that adds a cron
# registers nothing and the cron SILENTLY never runs (the 2026-07-07 email+push
# outage was this class of failure). It is idempotent — if already in sync the
# response just says so — and the retry is for a machine still finishing its
# rollout, NOT a full readiness poll (`flyctl deploy` already blocked until the
# new machines passed their health checks before this runs).
#
# Used by .github/actions/inngest-sync (the preview + production Fly deploy jobs)
# and scripts/fly-deploy.sh (the local hand-deploy). This file is the ONLY copy
# of the retry loop — before it existed the same 5-attempt curl was pasted in
# three places and drifted independently.
#
# Usage: scripts/inngest-sync.sh <inngest-endpoint-url>
#   e.g. scripts/inngest-sync.sh https://preview.spiralclass.com/api/inngest
set -euo pipefail

URL="${1:?usage: inngest-sync.sh <inngest-endpoint-url>}"

for i in $(seq 1 5); do
  response=$(curl -sS -X PUT "$URL" || true)
  echo "$response"
  if echo "$response" | grep -qE '"(message|modified)"'; then
    echo "Inngest sync confirmed"
    exit 0
  fi
  echo "sync attempt ${i}/5 did not confirm; retrying in 10s"
  sleep 10
done

echo "::error::Inngest sync never confirmed ($URL)" >&2
exit 1
