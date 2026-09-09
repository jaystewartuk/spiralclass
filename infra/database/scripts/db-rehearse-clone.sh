#!/usr/bin/env bash
# D-49 layer 3 (data) — rehearse a region clone against a THROWAWAY target, so
# the reproducible move is actually trusted before it matters. Spins an
# ephemeral Postgres, clones the source into it (schema+data), verifies parity
# (row count + content checksum), and tears the target down. Read-only w.r.t.
# the source; touches no real region.
#
# Usage:
#   db-rehearse-clone.sh [--schemas "public"] <source-url>
#
# Ephemeral target backend:
#   - default: a local Docker `postgres:<major>` container (major matched to the
#     source), on REHEARSE_PORT (default 55432), auto-removed on exit.
#   - REHEARSE_TARGET_URL=<url>: use this already-empty database instead of
#     Docker (e.g. a Supabase/Neon branch — D-49 calls out branching as ideal
#     for cheap rehearsal). Not dropped, only cloned into + verified.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

SCHEMAS="public"
POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    --schemas) SCHEMAS="${2:?--schemas needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \?//'; exit 0 ;;
    --*)       die "unknown option: $1" ;;
    *)         POSITIONAL+=("$1"); shift ;;
  esac
done
SOURCE="${POSITIONAL[0]:-${SOURCE_DATABASE_URL:-}}"
[ -n "$SOURCE" ] || die "no source URL (arg 1 or SOURCE_DATABASE_URL)."
require_tools psql

run_rehearsal() { # $1 = ephemeral target url
  echo "rehearsing clone into ephemeral target…" >&2
  ASSUME_YES=1 "$SCRIPT_DIR/db-clone-to-region.sh" --schemas "$SCHEMAS" "$SOURCE" "$1"
  echo "REHEARSAL PASSED — a clone of this source restores + verifies cleanly." >&2
}

if [ -n "${REHEARSE_TARGET_URL:-}" ]; then
  # Provided-DB backend (branch / preexisting empty DB). Nothing to spin/tear.
  run_rehearsal "$REHEARSE_TARGET_URL"
  exit 0
fi

# Docker backend.
require_tools docker
MAJOR="$(server_major "$SOURCE")"
PORT="${REHEARSE_PORT:-55432}"
NAME="spiralclass-rehearse-${PORT}"
PASS="rehearse"
EPHEMERAL="postgresql://postgres:${PASS}@127.0.0.1:${PORT}/postgres"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "starting ephemeral postgres:${MAJOR} (container ${NAME}, port ${PORT})…" >&2
docker run -d --rm --name "$NAME" -e "POSTGRES_PASSWORD=${PASS}" \
  -p "127.0.0.1:${PORT}:5432" "postgres:${MAJOR}" >/dev/null \
  || die "could not start the ephemeral container."

echo "waiting for it to accept connections…" >&2
for _ in $(seq 1 30); do
  if psql_scalar "$EPHEMERAL" 'select 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
psql_scalar "$EPHEMERAL" 'select 1' >/dev/null 2>&1 || die "ephemeral target never came up."

run_rehearsal "$EPHEMERAL"
# cleanup runs on EXIT
