#!/usr/bin/env bash
# Incident-recovery script: restore a Neon branch (default `production`) to an
# earlier point using Neon's instant restore (branching is copy-on-write
# against WAL history, so this is seconds, not a pg_dump/pg_restore cycle).
# See docs/deployment/DB_BACKUP_RESTORE.md for the full incident runbook this
# implements — this script is the "do it" step, not a substitute for reading
# that first if you've never run this before.
#
# Nothing here connects to the branch being restored FROM. `--list` reads
# `branches list` and the restore itself is `neonctl branches restore`, a
# control-plane operation against WAL history — so a checkpoint branch having
# no compute endpoint (neon-checkpoint.sh creates them with --no-compute) does
# not affect this path. The endpoint that matters is --target's, and --target
# is a live branch that already has one. If you want to INSPECT a checkpoint
# with psql before overwriting --target with it, attach an endpoint on demand
# first: `neonctl branches add-compute <checkpoint-name>`.
#
# Two sources to restore FROM:
#   1. A checkpoint branch created by neon-checkpoint.sh (pre-deploy, named
#      `pre-deploy-<timestamp>[-label]`) — the discoverable, named point from
#      right before a specific deploy. List them with --list.
#   2. Any arbitrary timestamp within the project's PITR retention window
#      (`--timestamp`), for "something went wrong at a moment that wasn't a
#      deploy" (a bad admin action, an application bug, an ad hoc query).
#
# `neonctl branches restore` ALWAYS preserves the target's pre-restore state
# under a new branch first (this script passes --preserve-under-name
# explicitly rather than relying on a default, so that safety net is never
# silently skipped) — so a restore is itself undoable if the wrong point was
# chosen. Nothing here deletes data; it only changes what `production` (or
# whichever --target you pick) currently points to.
#
# Usage:
#   neon-rollback.sh --list
#   neon-rollback.sh --from <checkpoint-branch-name> [--target production]
#   neon-rollback.sh --timestamp <RFC3339> [--target production]
#
# Options:
#   --list             List available checkpoint branches (created by
#                       neon-checkpoint.sh) and exit — use this first to find
#                       the checkpoint you want, then re-run with --from.
#   --from NAME        Restore --target to the state of this branch (typically
#                       a checkpoint branch name from --list).
#   --timestamp TS      Restore --target to this point in its OWN history
#                       (RFC3339, e.g. 2026-07-20T14:32:00Z). Mutually
#                       exclusive with --from.
#   --target NAME       Branch to restore (default: production). This is the
#                       branch that gets overwritten — double-check it.
#   --project-id ID     Overrides NEON_PROJECT_ID.
#   --yes               Skip the interactive confirmation (still logs what it
#                       did; only skips the "type yes" prompt).
#   -h, --help          This help.
#
# Requires NEON_PROJECT_ID in the environment (or --project-id), and a neonctl
# that can authenticate: its own stored credential (`neonctl auth`), or an
# explicit NEON_API_KEY. See ensure_neon_auth in _common.sh.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

TARGET="production"
FROM=""
TIMESTAMP=""
LIST=0
PROJECT_ID="${NEON_PROJECT_ID:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --list)       LIST=1; shift ;;
    --from)       FROM="${2:?--from needs a value}"; shift 2 ;;
    --timestamp)  TIMESTAMP="${2:?--timestamp needs a value}"; shift 2 ;;
    --target)     TARGET="${2:?--target needs a value}"; shift 2 ;;
    --project-id) PROJECT_ID="${2:?--project-id needs a value}"; shift 2 ;;
    --yes)        ASSUME_YES=1; shift ;;
    -h|--help)    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \?//'; exit 0 ;;
    --*)          die "unknown option: $1" ;;
    *)            die "unexpected argument: $1" ;;
  esac
done

[ -n "$PROJECT_ID" ] || die "NEON_PROJECT_ID is not set (and no --project-id given)."
require_tools npx

NEON_CLI=(npx --yes neonctl@latest)
NEON=("${NEON_CLI[@]}" --project-id "$PROJECT_ID")

# NEON_API_KEY if set, otherwise neonctl's stored credential (`neonctl auth`).
# This moves in lockstep with neon-checkpoint.sh deliberately: a rollback tool
# that authenticates differently from the checkpoint tool is one that fails
# during the incident it exists for, having looked fine every other day.
ensure_neon_auth "${NEON_CLI[@]}"

if [ "$LIST" = "1" ]; then
  echo "Checkpoint branches (newest first):" >&2
  "${NEON[@]}" branches list --output json </dev/null | node -e '
      const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const branches = Array.isArray(data) ? data : data.branches || [];
      branches
        .filter(b => typeof b.name === "string" && b.name.startsWith("pre-deploy-"))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .forEach(b => console.log(`  ${b.name}  (created ${b.created_at})`));
    '
  echo "" >&2
  echo "Restore with: --from <name>. Checkpoints carry no compute endpoint; to inspect one" >&2
  echo "with psql first, run 'neonctl branches add-compute <name>' to attach one." >&2
  exit 0
fi

if [ -n "$FROM" ] && [ -n "$TIMESTAMP" ]; then
  die "--from and --timestamp are mutually exclusive."
fi
if [ -z "$FROM" ] && [ -z "$TIMESTAMP" ]; then
  die "specify --from <checkpoint-branch> or --timestamp <RFC3339>, or --list to see checkpoints."
fi

SOURCE_DESC="$FROM"
if [ -n "$TIMESTAMP" ]; then
  SOURCE_ARG="^self@${TIMESTAMP}"
  SOURCE_DESC="own history at ${TIMESTAMP}"
else
  SOURCE_ARG="$FROM"
fi

BACKUP_NAME="${TARGET}_pre_rollback_$(date -u +%Y-%m-%dT%H%M%SZ)"

cat >&2 <<PLAN

  Neon rollback
  -------------
  target        : ${TARGET}   <-- this branch gets overwritten
  restoring from: ${SOURCE_DESC}
  safety net    : current ${TARGET} state preserved as '${BACKUP_NAME}' first

  This does not touch the app's DATABASE_URL/DIRECT_URL — if ${TARGET} is a
  connection string the app already uses (e.g. the production branch), the
  restored data is live the moment this completes. Put the app in maintenance
  mode first for anything but a read-only investigation.
PLAN
confirm "Restore '${TARGET}' now?"

"${NEON[@]}" branches restore "$TARGET" "$SOURCE_ARG" --preserve-under-name "$BACKUP_NAME" </dev/null
echo "" >&2
echo "Restored '${TARGET}' from ${SOURCE_DESC}. Pre-restore state saved as '${BACKUP_NAME}'." >&2
echo "Verify data (row counts, spot-check real records) before trusting this, then exit maintenance mode." >&2
