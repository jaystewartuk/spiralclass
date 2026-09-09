#!/usr/bin/env bash
# D-49 layer 3 (data) — logical clone of one Postgres into another via
# pg_dump | pg_restore. The universal, vendor-neutral region-move path: works
# between any two Postgres of compatible major version, any provider, any region
# (Supabase↔Supabase, Supabase→Neon, →RDS, →self-hosted). NEVER a provider's
# proprietary migration service (they re-lock you — D-49).
#
# Usage:
#   db-clone-to-region.sh [options] <source-url> <target-url>
#   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… db-clone-to-region.sh [options]
#
# Options:
#   --schema-and-data  Clone schema + data (DEFAULT). Target schema(s) must be
#                      EMPTY. `_prisma_migrations` rides along, so a later
#                      layer-2 `migrate deploy` on the new region is a clean
#                      no-op until the next migration. This is the one-time
#                      region-move path.
#   --data-only        Clone data only. Target must ALREADY have the schema —
#                      i.e. you ran layer-2 `migrate deploy` against it first, or
#                      you are seeding a logical-replication target. Loads with FK
#                      constraints dropped + user triggers disabled, then re-adds
#                      them (owner-permitted; the old --disable-triggers is
#                      superuser-only and fails on any managed Postgres).
#   --schemas "a b"    Schemas to clone (default: "public"). Space-separated.
#   --exclude-table N  Skip a table (public-schema name) on BOTH the dump and
#                      the parity verify. Repeatable. Use when the source still
#                      has a table the target's schema has since dropped (a
#                      merge/rename the target baseline already reflects) — e.g.
#                      cloning a pre-D-69 Supabase into the post-D-69 Neon
#                      baseline, where class_content / class_content_revisions /
#                      class_materials exist in the source but not the target.
#                      Without this, --data-only's --single-transaction restore
#                      aborts on the first "relation does not exist", and the
#                      verify flags the table as present-in-source only.
#   --yes              Skip the interactive confirmation (CI / rehearsal).
#   -h, --help         This help.
#
# Freeze window: this is the *snapshot* tier — stop writes to the source (or
# accept that rows written mid-dump may be missed) for the duration. At
# SpiralClass's data scale that is minutes. For a near-zero-downtime cutover use
# db-logical-replication.sh instead.
#
# Security (D-49): the dump is streamed source→target through a pipe, so no PII
# snapshot is ever written to disk. Connection strings come from argv/env and are
# never logged — only host/db are shown.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

MODE="schema-and-data"
SCHEMAS="public"
EXCLUDE_TABLES=()
POSITIONAL=()

while [ $# -gt 0 ]; do
  case "$1" in
    --schema-and-data) MODE="schema-and-data"; shift ;;
    --data-only)       MODE="data-only"; shift ;;
    --schemas)         SCHEMAS="${2:?--schemas needs a value}"; shift 2 ;;
    --exclude-table)   EXCLUDE_TABLES+=("${2:?--exclude-table needs a value}"); shift 2 ;;
    --no-verify)       DO_VERIFY=0; shift ;;
    --yes)             ASSUME_YES=1; shift ;;
    -h|--help)         sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \?//'; exit 0 ;;
    --*)               die "unknown option: $1" ;;
    *)                 POSITIONAL+=("$1"); shift ;;
  esac
done

SOURCE="${POSITIONAL[0]:-${SOURCE_DATABASE_URL:-}}"
TARGET="${POSITIONAL[1]:-${TARGET_DATABASE_URL:-}}"
[ -n "$SOURCE" ] || die "no source URL (pass as arg 1 or SOURCE_DATABASE_URL)."
[ -n "$TARGET" ] || die "no target URL (pass as arg 2 or TARGET_DATABASE_URL)."

require_tools pg_dump pg_restore psql

# --- Preconditions -----------------------------------------------------------
[ "$(url_summary "$SOURCE")" != "$(url_summary "$TARGET")" ] \
  || die "source and target are the same database ($(url_summary "$SOURCE")). Refusing."

psql_scalar "$SOURCE" 'select 1' >/dev/null 2>&1 || die "cannot connect to source ($(redact_url "$SOURCE"))."
psql_scalar "$TARGET" 'select 1' >/dev/null 2>&1 || die "cannot connect to target ($(redact_url "$TARGET"))."

SRC_MAJOR="$(server_major "$SOURCE")"
TGT_MAJOR="$(server_major "$TARGET")"
if [ "$TGT_MAJOR" -lt "$SRC_MAJOR" ]; then
  die "target is Postgres $TGT_MAJOR but source is $SRC_MAJOR; restore into an older major is unsupported."
fi

# Build the -n <schema> args and check the target's public state per mode.
NS_ARGS=()
for s in $SCHEMAS; do NS_ARGS+=(-n "$s"); done

TARGET_TABLES="$(list_tables "$TARGET" public | grep -c . || true)"
HAS_MIGRATIONS="$(psql_scalar "$TARGET" "select to_regclass('public._prisma_migrations') is not null")"

case "$MODE" in
  schema-and-data)
    if [ "$TARGET_TABLES" -gt 0 ]; then
      die "target public schema already has ${TARGET_TABLES} table(s). --schema-and-data needs an EMPTY target (provision it with layer 1, do NOT run layer-2 migrate first). Use --data-only to load data into a migrated target."
    fi ;;
  data-only)
    if [ "$HAS_MIGRATIONS" != "t" ]; then
      die "target has no public._prisma_migrations — its schema isn't there yet. Run layer-2 'migrate deploy' against the target first, then re-run with --data-only."
    fi ;;
esac

# --- Plan + confirm ----------------------------------------------------------
cat >&2 <<PLAN

  D-49 layer-3 clone
  ------------------
  mode     : ${MODE}
  schemas  : ${SCHEMAS}
  source   : $(url_summary "$SOURCE")   (Postgres ${SRC_MAJOR})
  target   : $(url_summary "$TARGET")   (Postgres ${TGT_MAJOR})

  Streams pg_dump → pg_restore (nothing written to disk). Make sure the source is
  write-frozen for the duration if you need a consistent snapshot.
PLAN
confirm "Clone into $(url_summary "$TARGET")?"

# --- Do it -------------------------------------------------------------------
echo "cloning…" >&2
# User-supplied --exclude-table names → pg_dump exclude patterns + verify
# excludes, so a table that exists in the source but not the target's schema
# can't abort the restore or fail the parity check. Empty-array expansion is
# safe under `set -u` here (same as NS_ARGS / VERIFY_EXCLUDES below).
DUMP_EXCLUDE_ARGS=()
VERIFY_EXCLUDES=()
for t in "${EXCLUDE_TABLES[@]}"; do
  DUMP_EXCLUDE_ARGS+=(--exclude-table="*.${t}")
  VERIFY_EXCLUDES+=(--exclude "$t")
done
if [ "$MODE" = "data-only" ]; then
  # The target already has identical migration history from layer-2 migrate
  # deploy; re-inserting those rows would collide on the PK, and their
  # applied_at differs anyway — so skip the table on both copy and verify.
  #
  # Trigger handling, privilege-portable: pg_restore --disable-triggers runs
  # `ALTER TABLE ... DISABLE TRIGGER ALL`, which is SUPERUSER-only for the
  # system RI (foreign-key) triggers — so it fails on every managed Postgres
  # (Neon/RDS/Supabase: "permission denied: ... is a system trigger"), breaking
  # the any-two-Postgres portability D-49 is built on. Instead do the
  # owner-permitted equivalent: capture + DROP the FK constraints (which removes
  # their RI triggers), DISABLE TRIGGER USER (owner-allowed, unlike ALL), load,
  # then re-enable + re-ADD. CHECK / exclusion constraints stay enforced — real
  # data satisfies them. A trap re-establishes integrity if the load aborts.
  SCHEMA_LIST="$(printf "'%s'," $SCHEMAS | sed 's/,$//')"
  _sel="select 'ALTER TABLE '||quote_ident(n.nspname)||'.'||quote_ident(c.relname)"
  _fk_from="from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where con.contype='f' and n.nspname in (${SCHEMA_LIST})"
  _tbl_from="from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in (${SCHEMA_LIST})"
  FK_DROP="$(psql "$TARGET" -tAXq -c "${_sel}||' DROP CONSTRAINT '||quote_ident(con.conname)||';' ${_fk_from}")"
  FK_ADD="$(psql "$TARGET" -tAXq -c "${_sel}||' ADD CONSTRAINT '||quote_ident(con.conname)||' '||pg_get_constraintdef(con.oid)||';' ${_fk_from}")"
  TRG_OFF="$(psql "$TARGET" -tAXq -c "${_sel}||' DISABLE TRIGGER USER;' ${_tbl_from}")"
  TRG_ON="$(psql "$TARGET" -tAXq -c "${_sel}||' ENABLE TRIGGER USER;' ${_tbl_from}")"
  _restore_integrity() { printf '%s\n%s\n' "$TRG_ON" "$FK_ADD" | psql "$TARGET" -q >/dev/null 2>&1 || true; }
  trap _restore_integrity EXIT
  echo "dropping FK constraints + disabling user triggers on target for the load…" >&2
  printf '%s\n%s\n' "$FK_DROP" "$TRG_OFF" | psql "$TARGET" -q -v ON_ERROR_STOP=1
  pg_dump -Fc --data-only --no-owner --no-privileges \
      --exclude-table='*._prisma_migrations' "${DUMP_EXCLUDE_ARGS[@]}" "${NS_ARGS[@]}" "$SOURCE" \
    | pg_restore --data-only --single-transaction \
        --no-owner --no-privileges -d "$TARGET"
  echo "re-enabling user triggers + re-adding FK constraints on target…" >&2
  printf '%s\n%s\n' "$TRG_ON" "$FK_ADD" | psql "$TARGET" -q -v ON_ERROR_STOP=1
  trap - EXIT
  VERIFY_EXCLUDES+=(--exclude _prisma_migrations)
else
  # schema-and-data into an EMPTY target. The target always has a `public`
  # schema already, so pg_dump's `CREATE SCHEMA public` is expected to fail —
  # that single error is benign. Anything else is fatal. (No --single-transaction
  # here precisely because that one benign error would otherwise roll back the
  # whole load; the mandatory verify below is what guarantees a partial restore
  # can't pass unnoticed.)
  set +e
  err="$({ pg_dump -Fc --no-owner --no-privileges "${DUMP_EXCLUDE_ARGS[@]}" "${NS_ARGS[@]}" "$SOURCE" \
          | pg_restore --no-owner --no-privileges -d "$TARGET"; } 2>&1 1>/dev/null)"
  set -e
  # pg_restore prints a benign "schema public already exists" error plus a
  # trailing "errors ignored on restore: N" summary. Tolerate exactly that one
  # error; treat any other error line, or an ignored-count > 1, as fatal.
  ignored="$(printf '%s\n' "$err" | sed -nE 's/.*errors ignored on restore: ([0-9]+).*/\1/p' | tail -1)"
  unexpected="$(printf '%s\n' "$err" | grep -iE 'error|fatal' \
                | grep -vE 'schema "public" already exists|errors ignored on restore' || true)"
  if [ -n "$unexpected" ] || [ "${ignored:-0}" -gt 1 ]; then
    printf '%s\n' "$err" >&2
    die "restore reported unexpected errors (above). Target may be non-empty or unreachable."
  fi
fi

if [ "${DO_VERIFY:-1}" = "1" ]; then
  echo "verifying parity…" >&2
  ASSUME_YES=1 "$SCRIPT_DIR/db-verify-clone.sh" --schemas "$SCHEMAS" \
    "${VERIFY_EXCLUDES[@]}" "$SOURCE" "$TARGET" \
    || die "clone completed but verification FAILED — do not cut over to this target."
  echo "clone verified." >&2
else
  echo "done (verification skipped). Run db-verify-clone.sh before cutting over." >&2
fi
