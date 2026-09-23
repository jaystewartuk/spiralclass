#!/usr/bin/env bash
# Push the production deploy's values from Infisical into the GitHub
# `production` Environment. One push target of two, beside
# infra/gcp/push-cloudrun-env.sh (Cloud Run runtime) —
# Infisical is the one vault and everything else holds a derived copy
# ([D-163] and its addenda).
#
# WHICH SECRETS, AND WHY THERE IS NO LIST IN THIS FILE. It pushes exactly the
# ones .github/workflows/deploy-production.yml reads, parsed out of the
# workflow's own `${{ secrets.X }}` references. A hand-kept list here would
# agree with the workflow on the day it was written and diverge the first time
# a value is added — the new secret would be declared in the workflow, pushed
# by nothing, and interpolate to the EMPTY STRING at deploy time, silently,
# because that is what an unset GitHub secret does. Derived, it cannot drift.
#
# ⚠️ It pushes ONLY those. Do NOT "simplify" this into an `infisical export |
# gh secret set` of everything: the deploy environment holding forty secrets
# instead of eleven is the blast radius D-163's addendum exists to bound.
#
# WHY A SCRIPT RATHER THAN INFISICAL'S NATIVE GITHUB SYNC. Both were on the
# table and the script won on two things the sync cannot offer:
#
#   * The sync needs a standing GitHub credential — an App install or a PAT —
#     held by Infisical, with write access to this repository's secrets. This
#     needs no standing credential at all: it uses the operator's own `gh`
#     session, at the moment they run it, and leaves nothing behind.
#   * A dashboard integration is invisible here. A reader of this repository
#     can see this file; they cannot see a sync configured in someone's
#     Infisical account.
#
# The honest cost is that it is MANUAL, and a manual sync is the one that gets
# forgotten after a rotation. Two things answer that rather than hoping:
# The (privately kept) rotation runbook names this script as a step, and the
# script VERIFIES itself — it re-reads what GitHub holds afterwards and fails
# if any name it meant to push is missing. It cannot detect a STALE value (no
# API returns a secret's value, by design), which is exactly why re-running it
# belongs in the rotation runbook rather than in someone's memory.
#
# Values flow through stdin only, never argv — the house rule (D-66), so
# nothing lands in shell history or in `ps`.
#
# STALE NAMES. A push only ever adds, so on its own it would make the GitHub
# copy derived for VALUES and not for NAMES: a secret the workflow stops
# reading would sit in the environment indefinitely, readable by any job that
# later names it (#106). So after verifying, it lists what the environment
# holds and reports every name the workflow does not read. It deletes them
# only behind --delete-stale, because a delete cannot be undone — GitHub never
# returns a value — and the report is what lets a human confirm the list is the
# workflow having moved on rather than this parse having broken.
#
# Requires: the Infisical CLI (logged in, this directory linked), `gh`
# (authenticated, with admin on the repository), and `jq`.
#
# Usage:
#   infra/infisical/push-github-secrets.sh                 push, verify, REPORT stale names
#   infra/infisical/push-github-secrets.sh --delete-stale  push, verify, DELETE stale names
#   REPO=jaystewartuk/spiralclass infra/infisical/push-github-secrets.sh
set -euo pipefail
INFISICAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$INFISICAL_DIR/../.."

ENVIRONMENT=production
GH_ENV=production
WORKFLOW=.github/workflows/deploy-production.yml

# Parsed before anything is read or pushed. An unknown argument is refused
# rather than ignored: `--delete-stail` silently becoming a report-only run is
# harmless, but a script that shrugs off flags it does not know teaches its
# operator that a flag they typed did something.
DELETE_STALE=0
for arg in "$@"; do
  case "$arg" in
    --delete-stale) DELETE_STALE=1 ;;
    *)
      echo "unknown argument: $arg" >&2
      echo "usage: infra/infisical/push-github-secrets.sh [--delete-stale]" >&2
      exit 1
      ;;
  esac
done

command -v infisical >/dev/null || {
  echo "install the Infisical CLI: https://infisical.com/docs/cli/overview" >&2
  exit 1
}
command -v gh >/dev/null || { echo "install the GitHub CLI: https://cli.github.com" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
[ -n "$REPO" ] || { echo "could not determine the repository — export REPO=owner/name" >&2; exit 1; }

# ── The names, from the workflow itself ──────────────────────────────────
# `${{ secrets.NAME }}`, deduplicated. GITHUB_TOKEN is excluded because it is
# minted per run and cannot be set.
# A `while read` loop rather than `mapfile`: that is a bash 4 builtin, and macOS
# ships bash 3.2 as /bin/bash — which this script found and died on the first
# time it ran. Nothing here needs bash 4, so meet the shell that is actually
# present rather than demanding a newer one via Homebrew.
#
# Comment lines are stripped FIRST, and that is not cosmetic: the workflow's own
# preflight comment explains the failure mode using `${{ secrets.X }}` as an
# example, and without this the script dutifully tried to push a secret called
# "X". A parser that cannot tell an instruction from an example is one that
# invents work.
NAMES=()
while IFS= read -r name; do
  [ -n "$name" ] && NAMES+=("$name")
done < <(
  sed 's/[[:space:]]*#.*$//' "$WORKFLOW" |
    grep -o '\${{ *secrets\.[A-Za-z0-9_]* *}}' |
    sed 's/.*secrets\.\([A-Za-z0-9_]*\).*/\1/' |
    grep -vx GITHUB_TOKEN | sort -u
)
[ "${#NAMES[@]}" -gt 0 ] || {
  echo "Found no \`secrets.*\` references in $WORKFLOW." >&2
  echo "Either the workflow stopped reading secrets — in which case this script is" >&2
  echo "obsolete and should go with it — or this parse broke. Do not push nothing." >&2
  exit 1
}
echo "› ${#NAMES[@]} secret(s) to push, read from $WORKFLOW:" >&2
printf '    %s\n' "${NAMES[@]}" >&2

# ── The values, from Infisical ───────────────────────────────────────────
# THREE paths, and the split is by CONSUMER rather than by how secret a value
# feels. The rule is one sentence:
#
#   `/` is the only path Fly gets.
#
# infra/gcp/push-cloudrun-env.sh reads `/` only, not recursive, and writes the
# lot into the secret the running production app mounts — so anything at `/`
# becomes an environment variable inside it.
# That makes the path a decision about exposure, not filing:
#
#   /         what the RUNNING APP needs — database URLs, Stripe, LiveKit's
#             secret. Pushed to Fly, by design.
#   /config   BUILD-time values, inlined into the client bundle and public by
#             construction. Must not become Fly runtime secrets (D-85 says so
#             explicitly), and do not, because they are not at `/`.
#   /deploy   credentials only this deploy uses — GCP_PROJECT_ID, GCP_DEPLOY_KEY,
#             NEON_API_KEY, LIVEKIT_ORIGIN_IP. ⚠️ These MUST NOT sit at `/`: a key
#             that can deploy the app, living inside the app it deploys, is a
#             privilege escalation waiting for one code-execution bug.
#
# This script reads all three because the deploy needs values from all three.
#
# --format=json so a value containing `=`, a newline or a quote survives; a
# dotenv round-trip through shell would not.
echo "› Reading Infisical \`${ENVIRONMENT}\` (paths: /, /config, /deploy)…" >&2
# shellcheck source=./infisical.sh
source "$INFISICAL_DIR/infisical.sh"

VALUES="$(
  infisical_env --json "$ENVIRONMENT" / /config /deploy \
    | jq -s 'add | map({(.key): .value}) | add // {}'
)"

# ── Push ─────────────────────────────────────────────────────────────────
missing=()
for name in "${NAMES[@]}"; do
  if ! jq -e --arg k "$name" 'has($k)' >/dev/null <<<"$VALUES"; then
    missing+=("$name")
    continue
  fi
  # Value to stdin, never to argv.
  jq -j --arg k "$name" '.[$k]' <<<"$VALUES" |
    gh secret set "$name" --repo "$REPO" --env "$GH_ENV"
  echo "    pushed $name" >&2
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "" >&2
  echo "  Not in Infisical's \`${ENVIRONMENT}\` environment at / or /config:" >&2
  printf '    %s\n' "${missing[@]}" >&2
  echo "" >&2
  echo "  The deploy reads these, and an unset GitHub secret is the EMPTY STRING" >&2
  echo "  rather than an error — so add them to Infisical and re-run, rather than" >&2
  echo "  setting them by hand here. A hand-set secret is the copy that stops" >&2
  echo "  matching." >&2
  exit 1
fi

# ── Verify ───────────────────────────────────────────────────────────────
# The half the old Fly push never had — its header said "UNVERIFIED IN THIS
# SESSION" from the day it was written until it was deleted. It cannot check a
# value — no API returns one — but "the name is set on the right environment"
# is checkable, and a typo'd name is the failure that otherwise surfaces as a
# deploy dying on an empty string.
echo "› Verifying against what GitHub now holds…" >&2
HELD="$(gh secret list --repo "$REPO" --env "$GH_ENV" --json name -q '.[].name' | sort)"
absent=()
for name in "${NAMES[@]}"; do
  grep -qx "$name" <<<"$HELD" || absent+=("$name")
done
if [ "${#absent[@]}" -gt 0 ]; then
  echo "  Pushed, but GitHub does not list:" >&2
  printf '    %s\n' "${absent[@]}" >&2
  exit 1
fi

# ── Stale names ──────────────────────────────────────────────────────────
# Everything the environment holds that the workflow does not read. HELD is the
# list the verify step just fetched, so this costs no extra call. A stale name
# is not an error — the push itself succeeded — so without --delete-stale this
# reports and the script still exits 0; failing would train the operator to
# pass the flag just to get a green run.
# ⚠️ Only deploy-production.yml uses the `production` environment. If another
# workflow ever does, its names must join NAMES before this runs, or this
# reports — and with the flag, deletes — secrets that workflow needs.
# A here-string rather than `printf | grep -q`: under pipefail, grep exiting on
# its first match can SIGPIPE the printf, fail the pipeline, and report a name
# the workflow DOES read as stale — the one mistake this step must never make.
READ_NAMES="$(printf '%s\n' "${NAMES[@]}")"
stale=()
while IFS= read -r name; do
  [ -n "$name" ] || continue
  grep -qxF "$name" <<<"$READ_NAMES" || stale+=("$name")
done <<<"$HELD"

# `${stale[@]}` is only expanded behind a length check: bash 3.2 treats an
# empty array as unbound under `set -u`.
if [ "${#stale[@]}" -gt 0 ]; then
  echo "" >&2
  echo "  On \`${GH_ENV}\` but not read by $WORKFLOW:" >&2
  printf '    %s\n' "${stale[@]}" >&2
  if [ "$DELETE_STALE" = 1 ]; then
    for name in "${stale[@]}"; do
      gh secret delete "$name" --repo "$REPO" --env "$GH_ENV"
      echo "    deleted $name" >&2
    done
    # Re-read rather than trust the exit codes, for the same reason the verify
    # step exists: what GitHub lists is the only evidence of what it holds.
    HELD="$(gh secret list --repo "$REPO" --env "$GH_ENV" --json name -q '.[].name' | sort)"
    remaining=()
    for name in "${stale[@]}"; do
      if grep -qxF "$name" <<<"$HELD"; then remaining+=("$name"); fi
    done
    if [ "${#remaining[@]}" -gt 0 ]; then
      echo "  Deleted, but GitHub still lists:" >&2
      printf '    %s\n' "${remaining[@]}" >&2
      exit 1
    fi
  else
    echo "" >&2
    echo "  Nothing reads these, and every job on the environment still could." >&2
    echo "  Nothing was deleted. Re-run with --delete-stale to remove them." >&2
  fi
fi

echo >&2
echo "Done. ${#NAMES[@]} secret(s) on ${REPO}'s \`${GH_ENV}\` environment." >&2
echo "⚠️ Re-run this after ANY rotation in Infisical — nothing here can see a" >&2
echo "   value that has gone stale, only a name that is absent." >&2
