# Shared helpers for the D-49 layer-3 data-movement scripts. Sourced, not run.
# Keep this POSIX-bash; every script sets `set -euo pipefail` before sourcing.

# Print to stderr and exit non-zero.
die() { echo "error: $*" >&2; exit 1; }

# Fail early if any required CLI tool is missing.
require_tools() {
  local missing=0 t
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 || { echo "missing required tool: $t" >&2; missing=1; }
  done
  [ "$missing" -eq 0 ] || die "install the missing tool(s) above and retry."
}

# Establish that neonctl can authenticate, before a script does anything that
# matters with it. Call as: ensure_neon_auth "${NEON_CLI[@]}"
#
# Two credentials, in preference order:
#   1. NEON_API_KEY in the environment, when it is set and non-empty. Exported
#      rather than passed as --api-key, so it never reaches argv where `ps` can
#      read it. This stays supported as an explicit override — another machine,
#      a scoped key, a one-off — it is simply no longer required.
#   2. neonctl's own stored OAuth credential (~/.config/neon/credentials.json),
#      written by `neonctl auth`.
#
# (2) is the normal path as of D-146's follow-up. The long-lived API key was
# fetched from Infisical's `infra` environment on every production deploy, and
# when those keys were deleted the deploy fail-closed at the checkpoint — with
# `production` already fast-forwarded and the app not deployed. Since this
# laptop is the only thing that deploys (D-129), a machine-local credential
# loses nothing that was actually in use, and removes a secret that has to
# exist, be valid and be rotated.
#
# The pre-check costs one cheap API call and buys a legible failure. Without it
# the first symptom is whatever the real command says, in the middle of a
# fail-closed production deploy, naming a key that is deliberately absent.
ensure_neon_auth() {
  if [ -n "${NEON_API_KEY:-}" ]; then
    export NEON_API_KEY
    return 0
  fi
  # </dev/null so a CLI that decides to prompt (neonctl asks which organization
  # to use when a command has to look across them) FAILS here rather than
  # hanging an unattended deploy forever.
  if "$@" me >/dev/null 2>&1 </dev/null; then
    return 0
  fi
  die "neonctl cannot authenticate.
  This needs one of:
    - a stored credential:  neonctl auth      (opens a browser once, per machine)
    - or an explicit key:   export NEON_API_KEY=…   (console.neon.tech > Account settings > API keys)
  Refusing to continue: the pre-migration checkpoint is what makes a bad
  migration recoverable (D-95), so it is never skipped."
}

# Strip the password from a postgres URL so it is safe to print.
# postgresql://user:pass@host:port/db?x=y  ->  postgresql://user:***@host:port/db?x=y
redact_url() {
  printf '%s\n' "$1" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#'
}

# A short, credential-free identity for a URL: user@host:port/dbname.
# Used to compare source vs target and to label output.
url_summary() {
  printf '%s\n' "$1" | sed -E 's#^[a-z]+://([^:/@]+)(:[^@]*)?@#\1@#; s#\?.*$##'
}

# Interactive guard. Skipped when ASSUME_YES=1 (set by --yes, CI, rehearsal).
confirm() {
  local prompt="${1:-Proceed?}"
  if [ "${ASSUME_YES:-0}" = "1" ]; then return 0; fi
  printf '%s [type "yes" to continue] ' "$prompt" >&2
  local reply; read -r reply
  [ "$reply" = "yes" ] || die "aborted."
}

# Run a scalar query, printing the single value (tuples-only, unaligned, quiet).
# ── Passwords never go on a command line ──────────────────────────────────
# `ps` shows every process's arguments to every user on the machine, and these
# scripts run for minutes against production. So a password travels only
# through the environment, which only its owner and root can read: D-66's rule
# for secrets, which these scripts predated until 2026-09-24.

# The URL's password, percent-decoded; empty when it has none.
url_password() {
  local pw pct='%'
  pw="$(printf '%s\n' "$1" | sed -nE 's#^[a-z]+://[^:/@]+:([^@]*)@.*#\1#p')"
  printf '%b' "${pw//$pct/\\x}"
}
url_without_password() { printf '%s\n' "$1" | sed -E 's#^([a-z]+://[^:/@]+):[^@]*@#\1@#'; }

# Run a libpq client against a URL: `pg <url> psql -tAc '…'`. The client gets
# `-d <url without its password>` and the password in PGPASSWORD, set for that
# one command only.
pg() {
  local url="$1" pw
  shift
  pw="$(url_password "$url")"
  if [ -n "$pw" ]; then
    PGPASSWORD="$pw" "$@" -d "$(url_without_password "$url")"
  else
    "$@" -d "$url"
  fi
}

# Refuse a password-carrying URL among a script's own arguments: by the time
# this runs it is already in `ps`, but refusing is what stops it becoming habit.
no_password_in_args() {
  local a
  for a in "$@"; do
    [ -z "$(url_password "$a")" ] || die "a database URL with a password was passed as an argument, where \`ps\` shows it to every user on this machine. Pass it in the environment instead: SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… $(basename "$0") …"
  done
}

psql_scalar() { pg "$1" psql -tAqc "$2"; }

# List base tables in the given schema (default: public), one per line.
list_tables() {
  local url="$1" schema="${2:-public}"
  psql_scalar "$url" \
    "select tablename from pg_tables where schemaname = '${schema}' order by tablename"
}

# Major version number of a server (e.g. 16). Used for compatibility checks.
# Every schema object a row checksum cannot see, one per line as
# kind<TAB>table<TAB>definition, sorted: extensions (database-wide), and the
# constraints, indexes, user triggers and non-extension functions of one
# schema. A clone missing an exclusion constraint has identical rows and a
# database that no longer refuses a double booking — this is what notices.
schema_objects() {
  local url="$1" schema="${2:-public}"
  psql_scalar "$url" "
    select k || E'\t' || t || E'\t' || d from (
      select 'extension' k, '' t, e.extname || ' in ' || n.nspname d
        from pg_extension e join pg_namespace n on n.oid = e.extnamespace
        where e.extname <> 'plpgsql'
      union all
      select 'constraint', c.relname, con.conname || ' ' || pg_get_constraintdef(con.oid)
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = '${schema}'
      union all
      select 'index', tablename, indexdef from pg_indexes where schemaname = '${schema}'
      union all
      select 'trigger', c.relname, pg_get_triggerdef(tg.oid)
        from pg_trigger tg
        join pg_class c on c.oid = tg.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        where not tg.tgisinternal and n.nspname = '${schema}'
      union all
      select 'function', '', p.proname || '(' || pg_get_function_identity_arguments(p.oid)
                              || ') ' || md5(pg_get_functiondef(p.oid))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = '${schema}' and p.prokind in ('f', 'p')
          and not exists (select 1 from pg_depend d
                          where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                            and d.deptype = 'e')
    ) x order by 1"
}

server_major() {
  local n; n="$(psql_scalar "$1" 'show server_version_num')"
  echo $(( n / 10000 ))
}
