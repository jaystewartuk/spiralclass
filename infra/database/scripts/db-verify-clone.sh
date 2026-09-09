#!/usr/bin/env bash
# D-49 layer 3 (data) — parity check between two Postgres databases. For every
# base table in the chosen schema(s) it compares (a) the row count and (b) an
# order-independent content checksum, and reports any divergence. A clone (or a
# logical-replication cutover) you cannot verify is a clone you cannot trust.
#
# Usage:
#   db-verify-clone.sh [--schemas "public"] <source-url> <target-url>
#
# Exit code: 0 = every table matches; 1 = at least one mismatch (or a table is
# missing on one side). Prints a per-table PASS/FAIL table to stderr.
#
# The checksum is md5 over the per-row md5s, aggregated order-independently, so
# it catches value drift that a bare row-count would miss and does not depend on
# physical row order (which differs after a dump/restore).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

SCHEMAS="public"
EXCLUDE=" "   # space-padded list of table names to skip (see --exclude)
POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    --schemas) SCHEMAS="${2:?--schemas needs a value}"; shift 2 ;;
    --exclude) EXCLUDE="${EXCLUDE}${2:?--exclude needs a value} "; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \?//'; exit 0 ;;
    --*)       die "unknown option: $1" ;;
    *)         POSITIONAL+=("$1"); shift ;;
  esac
done

SOURCE="${POSITIONAL[0]:-${SOURCE_DATABASE_URL:-}}"
TARGET="${POSITIONAL[1]:-${TARGET_DATABASE_URL:-}}"
[ -n "$SOURCE" ] || die "no source URL (arg 1 or SOURCE_DATABASE_URL)."
[ -n "$TARGET" ] || die "no target URL (arg 2 or TARGET_DATABASE_URL)."
require_tools psql

# Count + content hash for one schema.table. NULL-safe; empty table hashes to a
# stable sentinel so an empty↔empty pair still matches.
sig() {
  local url="$1" schema="$2" table="$3"
  psql_scalar "$url" "
    select count(*) || ':' || coalesce(
      md5(string_agg(rowhash, '' order by rowhash)), 'empty')
    from (select md5(t.*::text) as rowhash from \"${schema}\".\"${table}\" t) s"
}

fail=0
printf '  %-38s %-22s %-22s %s\n' "table" "source" "target" "" >&2
printf '  %s\n' "----------------------------------------------------------------------------------------" >&2

for schema in $SCHEMAS; do
  # Union of tables on both sides, so a table missing on one side is reported.
  tables="$(
    { list_tables "$SOURCE" "$schema"; list_tables "$TARGET" "$schema"; } | sort -u | grep . || true
  )"
  for table in $tables; do
    case "$EXCLUDE" in *" $table "*) continue ;; esac
    on_src="$(psql_scalar "$SOURCE" "select to_regclass('${schema}.${table}') is not null")"
    on_tgt="$(psql_scalar "$TARGET" "select to_regclass('${schema}.${table}') is not null")"
    if [ "$on_src" != "t" ] || [ "$on_tgt" != "t" ]; then
      printf '  %-38s %-22s %-22s %s\n' "${schema}.${table}" \
        "$([ "$on_src" = t ] && echo present || echo MISSING)" \
        "$([ "$on_tgt" = t ] && echo present || echo MISSING)" "FAIL" >&2
      fail=1; continue
    fi
    s_sig="$(sig "$SOURCE" "$schema" "$table")"
    t_sig="$(sig "$TARGET" "$schema" "$table")"
    if [ "$s_sig" = "$t_sig" ]; then
      printf '  %-38s %-22s %-22s %s\n' "${schema}.${table}" "${s_sig%%:*} rows" "${t_sig%%:*} rows" "PASS" >&2
    else
      printf '  %-38s %-22s %-22s %s\n' "${schema}.${table}" "${s_sig%%:*} rows" "${t_sig%%:*} rows" "FAIL" >&2
      fail=1
    fi
  done
done

if [ "$fail" -eq 0 ]; then
  echo "OK — all tables match (row count + content checksum)." >&2
else
  echo "MISMATCH — see FAIL rows above." >&2
fi
exit "$fail"
