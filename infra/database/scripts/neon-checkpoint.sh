#!/usr/bin/env bash
# Prune old checkpoints beyond a retention count, then create an explicit,
# named Neon branch checkpoint of a parent branch (default
# `production`). Prune-then-create, not the reverse — see the prune call
# below for why the order is load-bearing. This is the
# pre-deploy safety point that replaced the old pg_dump-to-R2 step (see D-95):
# a Neon branch is copy-on-write against the parent's WAL history, so creating
# one is seconds regardless of database size, and rolling back to it is
# `neon-rollback.sh` away — no separate restore target to provision, no
# pg_dump/pg_restore client-version matching to get wrong (that exact class of
# bug broke the old backup workflow on 2026-07-20, the day of the D-70 Neon
# cutover).
#
# This does NOT replace Neon's own point-in-time restore (PITR), which covers
# every moment within the project's retention window automatically with no
# action needed here. The checkpoint exists for two things PITR alone doesn't
# give you: a discoverable, named marker for "right before this specific
# deploy" (no need to hunt an exact timestamp during an incident), and a
# point that survives past the PITR retention window until pruned here.
#
# Checkpoints are created WITHOUT a compute endpoint (`--no-compute`). A
# restore point does not need one: `neon-rollback.sh` restores via
# `neonctl branches restore`, a control-plane operation against the branch's
# WAL history that never connects to the source branch, and `--list` reads
# `branches list`. An endpoint-less branch is the honest representation of a
# restore point, and it removes any chance of something waking a stale
# checkpoint. If you ever need to INSPECT a checkpoint's data before restoring
# from it, attach one on demand: `neonctl branches add-compute <name>`.
#
# Usage:
#   NEON_PROJECT_ID=… neon-checkpoint.sh [options]
#   NEON_API_KEY=… NEON_PROJECT_ID=… neon-checkpoint.sh [options]   (explicit key)
#
# Options:
#   --parent NAME    Branch to checkpoint (default: production).
#   --label NAME     Extra text folded into the checkpoint branch name
#                     (default: none). Useful to tag a checkpoint with the
#                     commit SHA it precedes.
#   --keep N         Number of most-recent checkpoints to retain for this
#                     parent, INCLUDING the one this run creates (default: 5).
#                     Neon branches are cheap (only diverging data costs
#                     storage) but not free, and they don't expire on their own
#                     the way PITR's WAL window does — pruning is required.
#                     Pruning runs BEFORE the new branch is created (to N-1),
#                     so this still works when the project is already at Neon's
#                     branch ceiling — see the comment at the prune call.
#                     Must be below the project's branch limit once
#                     `production` and any preview/dev branches are counted;
#                     that is now a checked precondition rather than something
#                     you find out from a failed create mid-deploy — see
#                     check_branch_ceiling below.
#   --project-id ID  Overrides NEON_PROJECT_ID.
#   --yes            Skip the interactive confirmation before pruning.
#   -h, --help       This help.
#
# Requires `NEON_PROJECT_ID` in the environment (or --project-id), and a
# neonctl that can authenticate: either its own stored credential from
# `neonctl auth`, or an explicit `NEON_API_KEY`. The key is no longer required
# — see ensure_neon_auth in _common.sh. Uses `npx neonctl` rather than
# requiring a local install — always resolves the newest CLI, which matters
# less here than it did for pg_dump (neonctl has no
# client-must-be->=-server-version failure mode), so pinning to `@latest` is
# safe and avoids the CLI itself rotting out from under this script.
# (Verified 2026-08-31: `npx neonctl@latest` resolved 4.13.0 and read the
# credential a locally-installed 3.6.0 had written, so the OAuth path survives
# the version skew `@latest` deliberately allows.)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

PARENT="production"
LABEL=""
# Retention: how many pre-deploy checkpoint branches to keep. This is the ONLY
# definition of that number — scripts/fly-deploy.sh calls this script without
# --keep precisely so it stays that way. (It used to be duplicated in
# .github/actions/neon-checkpoint/action.yml, which passed it explicitly; that
# action and every workflow in this repo were deleted by D-129.) Bounded from
# both sides and both bounds fail silently — too high hits the Neon project's
# branch ceiling mid-deploy, too low leaves no restore point for a bad migration
# noticed days later. A guard test enforces the range and the no-override:
# apps/web/tests/config/neon-checkpoint-retention.test.ts.
KEEP=5
PROJECT_ID="${NEON_PROJECT_ID:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --parent)     PARENT="${2:?--parent needs a value}"; shift 2 ;;
    --label)      LABEL="${2:?--label needs a value}"; shift 2 ;;
    --keep)       KEEP="${2:?--keep needs a value}"; shift 2 ;;
    --project-id) PROJECT_ID="${2:?--project-id needs a value}"; shift 2 ;;
    --yes)        ASSUME_YES=1; shift ;;
    -h|--help)    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \?//'; exit 0 ;;
    --*)          die "unknown option: $1" ;;
    *)            die "unexpected argument: $1" ;;
  esac
done

[ -n "$PROJECT_ID" ] || die "NEON_PROJECT_ID is not set (and no --project-id given)."
require_tools npx

# NEON_CLI is the bare CLI: `neonctl api` takes the project id in the request
# PATH, and passing --project-id alongside it is meaningless. Everything else
# goes through NEON, which pins the project for `branches …`.
NEON_CLI=(npx --yes neonctl@latest)
NEON=("${NEON_CLI[@]}" --project-id "$PROJECT_ID")

# NEON_API_KEY if it is set, otherwise neonctl's own stored credential
# (`neonctl auth`). See ensure_neon_auth in _common.sh for why the key stopped
# being required. Every call below pins --project-id or names the project in an
# API path, which is what keeps neonctl from asking which organization to use.
ensure_neon_auth "${NEON_CLI[@]}"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
NAME="pre-deploy-${STAMP}${LABEL:+-${LABEL}}"

case "$KEEP" in
  ''|*[!0-9]*) die "--keep must be a non-negative integer (got: '$KEEP')" ;;
esac

# Only prunes/counts branches whose name matches this parent's checkpoint
# prefix, so checkpoints for `production` and any other parent this is ever
# pointed at don't interfere with each other, and hand-created branches are
# left alone.
PREFIX="pre-deploy-"

# One read of the branch list, shared by the ceiling precondition and the
# pruner. Two separate `branches list` calls could disagree with each other if
# anything touched the project in between, which would make the precondition a
# statement about a project state that no longer exists.
# </dev/null on every neonctl call in this script, for two independent reasons.
# It stops a CLI that decides to prompt from hanging an unattended production
# deploy (neonctl asks which organization to use when a command has to look
# across them — every call here pins the project, but a future one might not).
# And in the prune loop below it is load-bearing: that loop feeds branch ids to
# `read` on stdin, so a child that read stdin would eat the rest of the list.
BRANCHES_JSON="$("${NEON[@]}" branches list --output json </dev/null)"

# --- Precondition: does this retention target fit under the branch ceiling? ---
# Neon enforces a per-project branch limit. Blowing through it surfaces as
# `branches create` failing with "branches limit exceeded" — and because the
# checkpoint is the FIRST step of the production deploy job (D-95 refuses to
# migrate without one), that aborts a production deploy with an error naming
# the symptom rather than the cause. Checking it up front turns "the deploy
# died at the Neon step" into "--keep is set higher than this project allows,
# here is the arithmetic", before anything is created or deleted.
#
# The check is on the STEADY state, not the current one: after pruning to
# KEEP-1 and creating one, this parent's checkpoints occupy exactly KEEP slots,
# alongside however many branches are not checkpoints (`production` itself,
# preview/dev branches, leftover `*_pre_rollback_*` branches from a past
# restore). If that sum exceeds the limit, no amount of pruning saves it.
check_branch_ceiling() {
  local limit others count required
  limit="$(branch_limit)"
  others="$(printf '%s' "$BRANCHES_JSON" | node -e '
      const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const branches = Array.isArray(data) ? data : data.branches || [];
      const prefix = process.argv[1];
      for (const b of branches) {
        if (typeof b.name === "string" && !b.name.startsWith(prefix)) console.log(b.name);
      }
    ' "$PREFIX")"
  count="$(printf '%s' "$others" | grep -c . || true)"

  if [ -z "$limit" ]; then
    # Deliberately NOT fatal. This precondition exists to stop a deploy from
    # dying on an unexplained ceiling error — failing closed because a metadata
    # field could not be read would invent a brand-new deploy blocker in the
    # name of removing one. The create below still fails closed on its own.
    echo "Warning: could not read this project's branch limit from the Neon API — skipping the retention precondition. If the create below fails with 'branches limit exceeded', --keep ($KEEP) is too high for this project." >&2
    return 0
  fi

  # KEEP=0 still creates one checkpoint (it just prunes everything first), so
  # the peak is never below 1 no matter what retention says.
  required=$(( count + (KEEP > 0 ? KEEP : 1) ))
  if [ "$required" -le "$limit" ]; then
    echo "Branch budget: ${count} non-checkpoint + --keep ${KEEP} = ${required} of ${limit} allowed." >&2
    return 0
  fi

  echo "::error::--keep ($KEEP) does not fit under this Neon project's branch ceiling. The project allows ${limit} branches; ${count} existing branch(es) are not '${PREFIX}*' checkpoints, so retaining ${KEEP} checkpoints alongside them needs ${required}. Creating the checkpoint would fail with 'branches limit exceeded' and abort this deploy." >&2
  if [ -n "$others" ]; then
    echo "Non-checkpoint branches counted:" >&2
    printf '%s\n' "$others" | sed 's/^/  - /' >&2
  fi
  echo "Fix by lowering KEEP (it lives once, in this script), deleting non-checkpoint branches that are no longer needed, or raising the project's branch limit. Do NOT bypass the checkpoint." >&2
  exit 1
}

# The project's per-project branch ceiling. It hangs off the project's OWNER
# (it is a property of the plan, not of the project), which is why this reads
# the raw API response rather than `neonctl projects get`. Prints nothing —
# not an error — if the call fails or the field is absent, so a Neon API shape
# change degrades this to a warning instead of blocking deploys.
branch_limit() {
  { "${NEON_CLI[@]}" api "/projects/${PROJECT_ID}" --output json 2>/dev/null </dev/null || true; } | node -e '
      try {
        const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
        const n = d?.owner?.branches_limit ?? d?.project?.owner?.branches_limit;
        if (Number.isFinite(n) && n > 0) console.log(n);
      } catch {}
    '
}

check_branch_ceiling

# --- Prune old checkpoints ---------------------------------------------------
prune_to() {
  local keep="$1" stale count
  stale="$(printf '%s' "$BRANCHES_JSON" \
    | node -e '
        const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
        const branches = Array.isArray(data) ? data : data.branches || [];
        const prefix = process.argv[1];
        const keep = Number(process.argv[2]);
        const matches = branches
          .filter(b => typeof b.name === "string" && b.name.startsWith(prefix))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        for (const b of matches.slice(keep)) console.log(b.id + "\t" + b.name);
      ' "$PREFIX" "$keep")"

  if [ -z "$stale" ]; then
    echo "No checkpoints beyond the most recent $keep — nothing to prune." >&2
    return 0
  fi
  count="$(printf '%s\n' "$stale" | grep -c .)"
  echo "" >&2
  echo "$count checkpoint(s) beyond the most recent $keep will be deleted:" >&2
  printf '%s\n' "$stale" | cut -f2 | sed 's/^/  - /' >&2
  confirm "Delete these old checkpoint branches?"
  printf '%s\n' "$stale" | cut -f1 | while read -r branch_id; do
    [ -n "$branch_id" ] || continue
    "${NEON[@]}" branches delete "$branch_id" >/dev/null </dev/null
  done
  echo "Pruned $count old checkpoint(s)." >&2
}

# Prune BEFORE creating, down to KEEP-1 so the new checkpoint lands inside the
# retention count rather than one over it.
#
# The order is load-bearing, not cosmetic. This script used to create first and
# prune second, which meant retention could never rescue a project already AT
# Neon's per-project branch ceiling: `branches create` failed with "branches
# limit exceeded", `set -e` aborted, and the prune that would have freed a slot
# was never reached. Because the checkpoint is the FIRST step of the production
# deploy job (D-95 refuses to migrate without one), that soft-locked production
# deploys entirely — every subsequent attempt failed identically, with no
# self-healing path. Production 2026-07-29: a fully-gated promote fast-forwarded
# `production`, the mobile OTA shipped, and the web deploy never ran, leaving
# the branch ref ahead of the deployed app.
prune_to "$(( KEEP > 0 ? KEEP - 1 : 0 ))"

echo "" >&2
echo "Creating checkpoint branch '${NAME}' from '${PARENT}'…" >&2
# --no-compute: see the header. A restore point needs no endpoint until someone
# actually restores, and `neon-rollback.sh` never connects to the checkpoint.
if ! "${NEON[@]}" branches create --parent "$PARENT" --name "$NAME" --no-compute --output json >/dev/null </dev/null; then
  # Still at the ceiling despite the precondition above (which warns instead of
  # failing when it can't read the limit) and despite pruning: --keep is at or
  # above what this Neon plan actually allows, once preview/dev branches and
  # `production` itself are counted. Pruning cannot fix that — the retention
  # target is simply too high.
  echo "::error::Failed to create the checkpoint branch. If this is 'branches limit exceeded', --keep ($KEEP) is too high for this Neon project's branch ceiling once non-checkpoint branches are counted. Lower KEEP (it lives once, in this script) or raise the project's limit; do NOT bypass the checkpoint." >&2
  exit 1
fi
echo "Created: ${NAME}" >&2
