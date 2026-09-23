#!/usr/bin/env bash
# Write the production app's runtime SECRETS into the Cloud Run target's one
# Secret Manager secret ([D-184]) — the same two sets Fly got, from the same
# two places:
#
#   * Infisical `production` at `/`, NOT recursive — exactly what
#     Fly's secrets import once took. Never `/config` and never `/deploy`,
#     for D-163's reason: `/` is the path that becomes an environment variable
#     inside the running app, and a deploy credential has no business there.
#   * The production R2 buckets' credentials, from infra/cloudflare-r2's Tofu
#     state — exactly what that module's push does on Fly (D-65).
#
# The committed runtime config (config/env/production.runtime.env) is NOT here.
# It is public, it changes with the commit, and it is already baked into the
# image and sourced at boot by scripts/docker-entrypoint.sh.
#
# ONE SECRET, holding the whole set as an env-file, because Secret Manager's
# free tier is six active versions and this app has ~18 secrets — eighteen of
# them would cost $0.72/month against a migration worth ~$7/month. The full
# reasoning, including the two non-cost reasons that matter more, is in
# infra/gcp/README.md.
#
# ⚠️ REWRITES THE WHOLE SET. There is no "update one key": this composes the
# file and adds a new version. That is the same shape as Fly's secrets import
# had, and it means this must be re-run after ANY rotation, in Infisical or
# in Tofu.
#
# ⚠️ Values flow through STDIN only, never argv (D-66). `gcloud secrets versions
# add --data-file=-` reads the composed file from a pipe; nothing here puts a
# secret where `ps` can read it. `printf` is a bash builtin, so the composition
# below is not a process argument either.
#
# Old versions are DISABLED rather than destroyed, and only after a new one is
# live: a destroyed version cannot be brought back, and a rollback to the
# previous image may want the previous secrets. Disabled versions are free
# (only ACTIVE ones count against the six).
#
# Requires: gcloud, the Infisical CLI (logged in), OpenTofu with
# infra/cloudflare-r2 initialised. Run it bare, from anywhere:
#
#   infra/gcp/push-cloudrun-env.sh <project-id>
set -euo pipefail

GCP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$GCP_DIR/../.." && pwd)"
INFISICAL_DIR="$REPO_ROOT/infra/infisical"
cd "$REPO_ROOT"

PROJECT="${1:-}"
if [ -z "$PROJECT" ]; then
  echo "usage: infra/gcp/push-cloudrun-env.sh <project-id>" >&2
  exit 1
fi

ENVIRONMENT=production

# ⚠️ SECRET_NAME comes from config/cloudrun/<env>.env — the file the DEPLOY
# reads to decide what to mount — and is never retyped here. A literal in this
# file that stopped matching it would write a new version of a secret nothing
# mounts, report success, and leave the running service on the old values. That
# is the worst shape a rotation can fail in: it looks done.
SHAPE="$REPO_ROOT/config/cloudrun/$ENVIRONMENT.env"
[ -f "$SHAPE" ] || { echo "missing $SHAPE" >&2; exit 1; }
# shellcheck disable=SC1090
set -a && . "$SHAPE" && set +a
[ -n "${SECRET_NAME:-}" ] || { echo "$SHAPE names no SECRET_NAME" >&2; exit 1; }

command -v gcloud >/dev/null || { echo "install the Google Cloud CLI" >&2; exit 1; }
command -v infisical >/dev/null || {
  echo "install the Infisical CLI: https://infisical.com/docs/cli/overview" >&2
  exit 1
}
TOFU="$(command -v tofu || command -v terraform)" || {
  echo "install OpenTofu (brew install opentofu)" >&2
  exit 1
}
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

# shellcheck source=../infisical/infisical.sh
source "$INFISICAL_DIR/infisical.sh"

# ── Source 1: what the app reads ─────────────────────────────────────────
# ⚠️ `/` ONLY, never --recursive — see the header.
echo "› Reading Infisical \`${ENVIRONMENT}\` / (not recursive)…" >&2
INFISICAL_JSON="$(infisical_env --json "$ENVIRONMENT" /)"

# ── Source 2: the R2 credentials ─────────────────────────────────────────
echo "› Reading the R2 bucket credentials from infra/cloudflare-r2's Tofu state…" >&2
if ! R2_JSON="$(cd infra/cloudflare-r2 && infisical_exec infra -- "$TOFU" output -json buckets)"; then
  echo "" >&2
  echo "  \`tofu output -json buckets\` failed in infra/cloudflare-r2, with Infisical" >&2
  echo "  \`infra\`'s credentials. Has \`tofu init\` been run in that directory?" >&2
  exit 1
fi

# ── Compose, and push over a pipe ────────────────────────────────────────
# node composes the env-file from the two JSON documents; its stdout is piped
# straight into gcloud. The composed text never lands on disk and never becomes
# an argument. scripts/cloudrun-env.mjs owns the grammar and the refusals.
echo "› Composing and writing a new version of \`$SECRET_NAME\`…" >&2
{
  printf '{"infisical":'
  printf '%s' "$INFISICAL_JSON"
  printf ',"r2":'
  printf '%s' "$R2_JSON"
  printf '}'
} | node scripts/cloudrun-env.mjs compose |
  gcloud secrets versions add "$SECRET_NAME" --data-file=- --project "$PROJECT"

# ── Retire the previous version, without destroying it ───────────────────
PREVIOUS="$(gcloud secrets versions list "$SECRET_NAME" --project "$PROJECT" \
  --filter='state:ENABLED' --sort-by=~createTime --format='value(name)' | sed -n 2p)"
if [ -n "$PREVIOUS" ]; then
  gcloud secrets versions disable "$PREVIOUS" --secret="$SECRET_NAME" --project "$PROJECT" --quiet
  echo "› Disabled version $PREVIOUS (not destroyed — a rollback may want it)." >&2
fi

cat >&2 <<EOF

› Done. The NEXT deploy picks it up:

    Cloud Run mounts \`$SECRET_NAME:latest\`, so a running revision keeps the
    version it started with. Nothing is live until a deploy rolls a new one —
    \`pnpm promote\`, or \`pnpm deploy:cloudrun\` by hand.
EOF
