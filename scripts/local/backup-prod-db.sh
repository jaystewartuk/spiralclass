#!/usr/bin/env bash
# Production DB backup — pg_dump prod, verify the archive, upload to R2, keep
# the last 14. Run it: `bash scripts/local/backup-prod-db.sh`.
#
# ON-DEMAND ONLY, AND NOT A PRACTICE. As of 2026-08-25 (D-129 addendum) the
# operator's decision is that **Neon already backs production up** and a
# hand-run dump is not a routine worth keeping. So this is NOT registered in
# scripts/local/jobs.mjs, there is no `pnpm local backup`, and nothing nags
# about it — a standing warning for a decision already made is the
# banner-nobody-reads failure the nag exists to avoid.
#
# It is kept, rather than deleted, for the one case Neon does not cover well:
# a copy that lives OUTSIDE Neon entirely, taken deliberately before something
# risky enough to want one. Take it by hand when you want that; otherwise
# production's recovery story is Neon's PITR plus the pre-migration checkpoint
# branch (D-95).
#
# It was .github/workflows/backup-prod-db.yml on a daily cron until D-129
# deleted every workflow in this repo. Same contract, same verification, same
# retention; the schedule is what went away, and then the practice with it.
#
# WHAT THIS IS NOT. It is the secondary, off-Neon disaster-recovery copy — not
# production's rollback mechanism. That is Neon's own point-in-time restore plus
# the pre-migration checkpoint branch scripts/fly-deploy.sh creates before any
# migration (D-95, docs/deployment/DB_BACKUP_RESTORE.md). This dump is what
# survives a Neon-account-level incident, or a bad migration noticed after the
# PITR window closed.
#
# FAILS CLOSED. A missing secret, a failed dump, or a dump that doesn't verify
# is an error, never a skip. That is not fussiness: this job was best-effort
# once, and a deploy proceeded with zero backup and nothing red to show for it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEEP=14
MIN_TABLES=30

# ── secrets ──────────────────────────────────────────────────────────────────
# Env wins (a one-off run with values pasted in); otherwise Infisical's
# `production` environment, which is where these five live now that there are no
# repo secrets to hold them. See docs/deployment/DB_BACKUP_RESTORE.md.
REQUIRED=(PROD_BACKUP_DB_URL R2_BACKUP_BUCKET R2_BACKUP_ENDPOINT R2_BACKUP_ACCESS_KEY R2_BACKUP_SECRET)
missing=()
for name in "${REQUIRED[@]}"; do
  [ -z "${!name:-}" ] && missing+=("$name")
done

if [ ${#missing[@]} -gt 0 ]; then
  # shellcheck source=/dev/null
  source "$REPO_ROOT/infra/infisical/with-secret.sh"
  infisical_export_secrets --env production "${missing[@]}"
fi

for name in "${REQUIRED[@]}"; do
  if [ -z "${!name:-}" ]; then
    echo "error: $name is not set, and Infisical did not supply it." >&2
    echo "       Refusing to proceed without a backup — all of ${REQUIRED[*]} are required." >&2
    exit 1
  fi
done

# ── pg_dump, and it must be at least as new as the server ────────────────────
# pg_dump refuses to dump a server newer than itself, so a hardcoded major is a
# time bomb that goes off when the managed provider upgrades underneath us —
# which already happened once (Neon moved production to PG 18; the pinned
# client-17 stopped being able to dump it). Resolve the newest thing on this
# machine instead of naming a version.
if ! command -v pg_dump >/dev/null 2>&1; then
  for candidate in /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin \
    $(ls -d /opt/homebrew/opt/postgresql@*/bin 2>/dev/null | sort -V | tail -1); do
    [ -x "$candidate/pg_dump" ] && export PATH="$candidate:$PATH" && break
  done
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "error: pg_dump not found. Install the client:  brew install libpq" >&2
  echo "       (and either brew link --force libpq, or let this script find it)" >&2
  exit 1
fi
command -v aws >/dev/null 2>&1 || { echo "error: aws CLI not found. brew install awscli" >&2; exit 1; }

# psql is version-tolerant even where pg_dump is not, so it can read the server
# version in exactly the case pg_dump would refuse — which is the case worth
# diagnosing precisely rather than leaving the operator with pg_dump's terse
# "aborting because of server version mismatch".
SERVER_VERSION_NUM="$(psql "$PROD_BACKUP_DB_URL" -tAc 'SHOW server_version_num')"
SERVER_MAJOR=$((SERVER_VERSION_NUM / 10000))
CLIENT_MAJOR="$(pg_dump --version | awk '{print $3}' | cut -d. -f1)"
echo "Server major: $SERVER_MAJOR | pg_dump major: $CLIENT_MAJOR ($(command -v pg_dump))"
if [ "$CLIENT_MAJOR" -lt "$SERVER_MAJOR" ]; then
  echo "error: pg_dump $CLIENT_MAJOR cannot dump a PostgreSQL $SERVER_MAJOR server" >&2
  echo "       (a dump client must be >= the server major). Upgrade it:  brew upgrade libpq" >&2
  echo "       Refusing to proceed without a backup." >&2
  exit 1
fi

# ── dump ─────────────────────────────────────────────────────────────────────
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FILE="prod-$(date -u +%Y-%m-%dT%H%M%SZ).dump"

echo "Dumping production…"
pg_dump "$PROD_BACKUP_DB_URL" -Fc --no-owner --no-privileges -f "$WORK/$FILE"

# Verify before trusting it: a structurally valid custom-format archive with a
# non-trivial number of tables. Catches a truncated file, or a dump taken
# against an empty or wrong database — both of which otherwise exit 0 and get
# uploaded as if they were a real backup. The threshold only has to catch
# "essentially empty", not track the schema's exact table count.
TABLE_COUNT="$(pg_restore --list "$WORK/$FILE" 2>/dev/null | grep -c 'TABLE DATA' || true)"
echo "Dump contains $TABLE_COUNT table(s) with data entries."
if [ "$TABLE_COUNT" -lt "$MIN_TABLES" ]; then
  echo "error: backup verification failed — $TABLE_COUNT table(s), expected at least $MIN_TABLES," >&2
  echo "       or the archive is corrupt. Refusing to upload or call this a backup." >&2
  exit 1
fi

# ── upload + retention ───────────────────────────────────────────────────────
export AWS_ACCESS_KEY_ID="$R2_BACKUP_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$R2_BACKUP_SECRET"
export AWS_DEFAULT_REGION=auto

aws s3 cp "$WORK/$FILE" "s3://${R2_BACKUP_BUCKET}/${FILE}" --endpoint-url "$R2_BACKUP_ENDPOINT"
echo "Uploaded $FILE ($TABLE_COUNT tables) to R2 bucket $R2_BACKUP_BUCKET"

aws s3 ls "s3://${R2_BACKUP_BUCKET}/" --endpoint-url "$R2_BACKUP_ENDPOINT" \
  | awk '{print $4}' | grep '^prod-.*\.dump$' | sort -r | tail -n "+$((KEEP + 1))" \
  | while read -r stale; do
      echo "Pruning old backup: $stale"
      aws s3 rm "s3://${R2_BACKUP_BUCKET}/${stale}" --endpoint-url "$R2_BACKUP_ENDPOINT"
    done

echo "Backup complete."
