#!/usr/bin/env bash
# Push this Fly app's env secrets — everything the app needs EXCEPT the R2
# credentials (those stay Tofu-owned, see D-65 and
# infra/cloudflare-r2/push-fly-secrets.sh) — from Infisical to Fly. Mirrors
# that script's house style: values flow through stdin only, never argv, so
# nothing lands in shell history or `ps`. See
# docs/decisions/D-66.md.
#
# Requires:
#   - the Infisical CLI installed and logged in (`infisical login`)
#   - this directory linked to the "spiralclass" Infisical project
#     (`infisical init`, once — writes .infisical.json here, gitignored since
#     D-158, which
#     Infisical's own scaffolding gitignores; double check it's not tracked
#     before committing anything in this directory)
#
# Usage:
#   FLY_APP=agendaprofe INFISICAL_ENV=preview ./push-fly-secrets.sh
#
# UNVERIFIED IN THIS SESSION: no network path to app.infisical.com or
# api.fly.io from here. `infisical export`'s exact flag name/output format
# and `fly secrets import`'s stdin format are best-effort from documented CLI
# usage, not confirmed live. Run once by hand and check `fly secrets list`
# (names only) before relying on this — if `--format=dotenv` doesn't produce
# plain `KEY=value` lines flyctl accepts, fix this script against the real
# CLI output before retrying, don't fall back to `fly secrets set
# KEY=value ...` on the command line (that leaks values into shell
# history/`ps`).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

: "${FLY_APP:?export FLY_APP=<the fly.toml app name, e.g. agendaprofe>}"
: "${INFISICAL_ENV:?export INFISICAL_ENV=<Infisical environment slug, e.g. preview or production>}"

command -v infisical >/dev/null || { echo "install the Infisical CLI: https://infisical.com/docs/cli/overview" >&2; exit 1; }
command -v flyctl >/dev/null || command -v fly >/dev/null || { echo "install flyctl (https://fly.io/install.sh)" >&2; exit 1; }
FLYCTL="$(command -v flyctl || command -v fly)"

echo "Reading '${INFISICAL_ENV}' secrets from Infisical …" >&2
# --format=dotenv emits plain KEY=value lines (no `export` prefix) —
# flyctl's `secrets import` reads that shape directly from stdin.
# ⚠️ NO `--path`, WHICH MEANS `/` AND NOT RECURSIVE. That is not an oversight
# to tidy up — it is the mechanism that keeps things OUT of the running app.
# Everything this line returns becomes an environment variable inside the
# production container, so `/` is the definition of "the app needs this", and
# the two sibling paths exist precisely because their contents must not end up
# here: `/config` holds build-time values D-85 says must never be Fly secrets,
# and `/deploy` holds the deploy's own credentials — a Fly token that can
# deploy the app has no business living inside the app it deploys.
#
# Adding `--recursive` here would silently undo both.
# ⚠️ ALWAYS an explicit, VERIFIED project. This script WRITES — aimed at the
# wrong project it overwrites live secrets — so it must never infer one.
# shellcheck source=./infisical.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/infisical.sh"

# ⚠️ `/` ONLY, and no --recursive. `/config` holds build-time values D-85 says
# must never be Fly secrets, and `/deploy` holds the deploy's own credentials —
# a Fly token that can deploy the app has no business inside the app it deploys.
SECRETS_INPUT="$(infisical_env "${INFISICAL_ENV}" /)"

COUNT="$(echo "$SECRETS_INPUT" | grep -c '=' || true)"
if [ "$COUNT" -eq 0 ]; then
  echo "No secrets found in Infisical environment '${INFISICAL_ENV}' — nothing to push. Did you add secrets in the Infisical dashboard/CLI yet?" >&2
  exit 1
fi

echo "Pushing ${COUNT} secrets to Fly app '${FLY_APP}' (this restarts running machines) …" >&2
echo "$SECRETS_INPUT" | "$FLYCTL" secrets import --app "$FLY_APP"

echo >&2
echo "Done. Verify with: fly secrets list --app ${FLY_APP} (names only, values are never shown)." >&2
echo "Reminder: R2 credentials are NOT in Infisical (Tofu-owned, D-65) — push those separately with infra/cloudflare-r2/push-fly-secrets.sh." >&2
