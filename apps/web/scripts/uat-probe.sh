#!/usr/bin/env bash
#
# UAT §0 live-deployment probe — health + Stripe-webhook-refusal, run locally so
# it costs zero CI minutes (preview isn't continuously monitored the way prod is;
# prod's equivalent is scripts/local/synthetic.sh, run by hand and by promote —
# there is no schedule anywhere since D-129). Same two
# checks as /admin/uat's §0 "Run probe" button, so the operator reads PASS/FAIL instead of
# hand-typing curls and eyeballing status codes.
#
# Usage:
#   pnpm uat:probe                 # defaults to preview
#   pnpm uat:probe https://spiralclass.com     # or point at prod post-promote
#   BASE_URL=https://... pnpm uat:probe
#
# Exit 0 only if BOTH checks pass; non-zero (and a red FAIL line) otherwise.
set -euo pipefail

BASE_URL="${1:-${BASE_URL:-https://preview.spiralclass.com}}"
BASE_URL="${BASE_URL%/}" # strip any trailing slash

red() { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }

echo "→ probing ${BASE_URL}"
fail=0

# 1. Health — expect HTTP 200 and a db:"ok" marker.
health_body=$(curl -sS -w $'\n%{http_code}' --max-time 15 "${BASE_URL}/api/health" || printf '\n000')
health_code=$(printf '%s\n' "$health_body" | tail -n1)
health_json=$(printf '%s\n' "$health_body" | sed '$d')
if [ "$health_code" = "200" ] && printf '%s' "$health_json" | grep -q '"db":"ok"'; then
  green "PASS  health          200, db:ok"
else
  red "FAIL  health          got HTTP ${health_code} — ${health_json:-<no body>}"
  red "      (503 → preview is broken; fix before proceeding)"
  fail=1
fi

# 2. Stripe Connect webhook must reject a forged signature — expect HTTP 401.
#   200 → signature verification BYPASSED (hard blocker)
#   503 → STRIPE_WEBHOOK_SECRET missing on the deploy (redeploy)
#   401 → correct refusal
wh_code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 \
  -X POST "${BASE_URL}/api/stripe/webhook" \
  -H "Content-Type: application/json" \
  -H "stripe-signature: t=1,v1=garbage" \
  -d '{"id":"evt_uat_probe","type":"ping"}' || echo 000)
if [ "$wh_code" = "401" ]; then
  green "PASS  webhook-refusal  401"
else
  red "FAIL  webhook-refusal  got HTTP ${wh_code}, expected 401"
  if [ "$wh_code" = "200" ]; then red "      (200 → signature verification BYPASSED — HARD BLOCKER)"; fi
  if [ "$wh_code" = "503" ]; then red "      (503 → STRIPE_WEBHOOK_SECRET missing on the deploy — redeploy)"; fi
  fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  green "§0 probe: all checks passed"
else
  red "§0 probe: one or more checks FAILED — do not promote"
  exit 1
fi
