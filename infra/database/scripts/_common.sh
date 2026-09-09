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
psql_scalar() { psql "$1" -tAqc "$2"; }

# List base tables in the given schema (default: public), one per line.
list_tables() {
  local url="$1" schema="${2:-public}"
  psql_scalar "$url" \
    "select tablename from pg_tables where schemaname = '${schema}' order by tablename"
}

# Major version number of a server (e.g. 16). Used for compatibility checks.
server_major() {
  local n; n="$(psql_scalar "$1" 'show server_version_num')"
  echo $(( n / 10000 ))
}
