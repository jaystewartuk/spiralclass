#!/usr/bin/env bash
# D-49 layer 3 (data) — near-zero-downtime region cutover via Postgres logical
# replication. The other tier (db-clone-to-region.sh) needs a write-freeze;
# this one seeds the target and then STREAMS the delta so the freeze is just the
# final flip. Postgres-native only (CREATE PUBLICATION / SUBSCRIPTION) — never a
# provider's proprietary CDC service (D-49).
#
# Prereqs: the SOURCE must run with wal_level=logical (Supabase: enable in
# dashboard; self-hosted: postgresql.conf). The TARGET must ALREADY have the
# schema — logical replication does NOT carry DDL — so run layer-2 `migrate
# deploy` against the target first. Every replicated table needs a PK (replica
# identity); ours do.
#
# Subcommands:
#   publish   <source-url> [pubname] [schema]
#       CREATE PUBLICATION for all tables in <schema> (default public) on source.
#   subscribe <target-url> <source-conninfo> [subname] [pubname]
#       CREATE SUBSCRIPTION on target; copies existing rows then streams. Add
#       --no-copy if the target was already seeded by db-clone-to-region.sh.
#   status    <target-url> [source-url]
#       Show subscription progress on target (+ slot lag on source if given).
#   sync-sequences <source-url> <target-url> [schema]
#       Advance target sequences to match source. Logical replication does NOT
#       replicate sequences — run this at cutover or the target hands out
#       duplicate ids. (Post-freeze, pre-flip.)
#   teardown  <target-url> <source-url> [subname] [pubname]
#       DROP SUBSCRIPTION on target + DROP PUBLICATION on source. Run after the
#       app pointer is flipped and verified.
#
# Cutover order (see ../RUNBOOK.md): publish → subscribe → poll status to ~0 lag
# → freeze source writes → status 0 + db-verify-clone.sh → sync-sequences → flip
# app region pointer → teardown.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

DEFAULT_PUB="agendaprofe_region_pub"
DEFAULT_SUB="agendaprofe_region_sub"

cmd_publish() {
  local src="${1:?source-url}" pub="${2:-$DEFAULT_PUB}" schema="${3:-public}"
  require_tools psql
  [ "$(server_major "$src")" -ge 15 ] || die "publish needs Postgres 15+ (FOR TABLES IN SCHEMA)."
  local wal; wal="$(psql_scalar "$src" 'show wal_level')"
  [ "$wal" = "logical" ] || die "source wal_level is '$wal', need 'logical'. Enable it and restart the source first."
  if [ "$(psql_scalar "$src" "select 1 from pg_publication where pubname='${pub}'")" = "1" ]; then
    echo "publication ${pub} already exists on source — leaving as is." >&2; return 0
  fi
  psql "$src" -v ON_ERROR_STOP=1 -qc "create publication \"${pub}\" for tables in schema \"${schema}\""
  echo "created publication ${pub} (schema ${schema}) on $(url_summary "$src")." >&2
}

cmd_subscribe() {
  local no_copy=false
  [ "${1:-}" = "--no-copy" ] && { no_copy=true; shift; }
  local tgt="${1:?target-url}" conninfo="${2:?source-conninfo}" sub="${3:-$DEFAULT_SUB}" pub="${4:-$DEFAULT_PUB}"
  require_tools psql
  [ "$(psql_scalar "$tgt" "select to_regclass('public._prisma_migrations') is not null")" = "t" ] \
    || die "target has no schema (no public._prisma_migrations). Run layer-2 migrate deploy first."
  if [ "$(psql_scalar "$tgt" "select 1 from pg_subscription where subname='${sub}'")" = "1" ]; then
    echo "subscription ${sub} already exists on target — leaving as is." >&2; return 0
  fi
  local copy="true"; $no_copy && copy="false"
  psql "$tgt" -v ON_ERROR_STOP=1 -qc \
    "create subscription \"${sub}\" connection '${conninfo}' publication \"${pub}\" with (copy_data = ${copy})"
  echo "created subscription ${sub} on $(url_summary "$tgt") (copy_data=${copy}); initial sync started." >&2
}

cmd_status() {
  local tgt="${1:?target-url}" src="${2:-}"
  require_tools psql
  echo "— subscription state (target) —" >&2
  psql "$tgt" -c "select subname, received_lsn, latest_end_lsn,
    (latest_end_lsn = received_lsn) as caught_up from pg_stat_subscription" >&2
  psql "$tgt" -c "select srsubid, srrelid::regclass as table, srsubstate as state
    from pg_subscription_rel order by 2" >&2 || true
  if [ -n "$src" ]; then
    echo "— replication slot lag (source) —" >&2
    psql "$src" -c "select slot_name, active,
      pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) as behind
      from pg_replication_slots" >&2
  fi
}

cmd_sync_sequences() {
  local src="${1:?source-url}" tgt="${2:?target-url}" schema="${3:-public}"
  require_tools psql
  local seqs; seqs="$(psql_scalar "$src" \
    "select sequencename from pg_sequences where schemaname='${schema}' order by 1")"
  [ -n "$seqs" ] || { echo "no sequences in ${schema} — nothing to sync." >&2; return 0; }
  local s last
  for s in $seqs; do
    last="$(psql_scalar "$src" "select last_value from \"${schema}\".\"${s}\"")"
    psql_scalar "$tgt" "select setval('\"${schema}\".\"${s}\"', ${last}, true)" >/dev/null
    echo "  ${schema}.${s} -> ${last}" >&2
  done
  echo "sequences synced." >&2
}

cmd_teardown() {
  local tgt="${1:?target-url}" src="${2:?source-url}" sub="${3:-$DEFAULT_SUB}" pub="${4:-$DEFAULT_PUB}"
  require_tools psql
  # Dropping the subscription also drops the replication slot on the source when
  # the connection is live. If the source is already gone, disable+detach first.
  if [ "$(psql_scalar "$tgt" "select 1 from pg_subscription where subname='${sub}'")" = "1" ]; then
    psql "$tgt" -qc "drop subscription \"${sub}\"" 2>/dev/null \
      || { psql "$tgt" -qc "alter subscription \"${sub}\" disable";
           psql "$tgt" -qc "alter subscription \"${sub}\" set (slot_name = none)";
           psql "$tgt" -qc "drop subscription \"${sub}\""; }
    echo "dropped subscription ${sub} on target." >&2
  fi
  if [ "$(psql_scalar "$src" "select 1 from pg_publication where pubname='${pub}'")" = "1" ]; then
    psql "$src" -qc "drop publication \"${pub}\""
    echo "dropped publication ${pub} on source." >&2
  fi
}

sub="${1:-}"; shift || true
case "$sub" in
  publish)        cmd_publish "$@" ;;
  subscribe)      cmd_subscribe "$@" ;;
  status)         cmd_status "$@" ;;
  sync-sequences) cmd_sync_sequences "$@" ;;
  teardown)       cmd_teardown "$@" ;;
  -h|--help|"")   sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \?//' ;;
  *)              die "unknown subcommand: $sub (try --help)" ;;
esac
