#!/usr/bin/env bash
# Test for oracle-render-livekit.sh PREVIEW_DB_PASSWORD generation.
#
# Scenarios (issue #110: first deploy to a rebuilt box stops at render because
# nothing generates preview's database password):
#   - happy_path:   no PREVIEW_DB_PASSWORD   → non-empty password in .env and preview-db.env
#   - null:         PREVIEW_DB_PASSWORD unset   → generates one (same as happy path)
#   - empty:        PREVIEW_DB_PASSWORD=""      → generates one
#   - boundary:     generated password length within [1, 32], never empty
#   - negative:     missing output directory   → refused with a usage error
#   - concurrency:  two simultaneous renders   → both succeed, one per directory
#   - regression:   second render with the generated password → written back unchanged
#
# Mocks the infisical CLI so the render can run without reaching Infisical.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RENDER_SCRIPT="${REPO_ROOT}/scripts/oracle-render-livekit.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── Mock infisical CLI ──────────────────────────────────────────────────────
MOCK_BIN="${TMP}/bin"
mkdir -p "$MOCK_BIN"
cat > "${MOCK_BIN}/infisical" <<'MOCK'
#!/usr/bin/env bash
# Pretend to be the Infisical CLI: return dummy dotenv for any secrets get.
case "${1:-}" in
  secrets)
    case "${2:-}" in
      get)
        # Emit two dummy LiveKit secrets in dotenv format.
        printf 'LIVEKIT_API_KEY=dummy-key-12345\nLIVEKIT_API_SECRET=dummy-secret-67890\n'
        ;;
      *) echo "mock infisical: unknown subcommand $*" >&2; exit 1 ;;
    esac
    ;;
  *) echo "mock infisical: unknown command $*" >&2; exit 1 ;;
esac
MOCK
chmod +x "${MOCK_BIN}/infisical"
export PATH="${MOCK_BIN}:${PATH}"
export INFISICAL_SKIP_PROJECT_CHECK=1
export INFISICAL_PROJECT_ID=test-project-id

pass=0
fail=0

ok()   { printf '  ok   %s\n' "$*"; pass=$((pass+1)); }
not_ok() { printf '  not ok %s\n' "$*" >&2; fail=$((fail+1)); }

# ── Helper: run the render and capture output files ─────────────────────────
# On failure the render's stderr is surfaced to this test's stderr: on the
# unfixed script the render aborts with `PREVIEW_DB_PASSWORD: unbound variable`
# (set -u), and that message must reach the caller instead of disappearing
# into a temp file that the trap removes.
run_render() {
  local out_dir="$1"; shift
  # Unset PREVIEW_DB_PASSWORD unless explicitly passed in the environment.
  if [ "${WITH_PASSWORD:-}" = "1" ]; then
    export PREVIEW_DB_PASSWORD="${PASSWORD_VALUE:-}"
  else
    unset PREVIEW_DB_PASSWORD || true
  fi
  "${RENDER_SCRIPT}" "$out_dir" >"${TMP}/render.stdout" 2>"${TMP}/render.stderr" || {
    cat "${TMP}/render.stderr" >&2 || true
    return 1
  }
}

# ── Test 1: Happy path — no PREVIEW_DB_PASSWORD → non-empty generated one ──
printf '\n--- happy path: no PREVIEW_DB_PASSWORD ---\n'
OUT1="${TMP}/out1"
WITH_PASSWORD= run_render "$OUT1"
if [ -f "${OUT1}/.env" ] && [ -f "${OUT1}/preview-db.env" ]; then
  ok "render produced .env and preview-db.env"
else
  not_ok "render produced .env and preview-db.env"
fi

PWD_IN_ENV="$(sed -n 's/^PREVIEW_DB_PASSWORD=//p' "${OUT1}/.env")"
if [ -n "$PWD_IN_ENV" ]; then
  ok ".env has non-empty PREVIEW_DB_PASSWORD (len=${#PWD_IN_ENV})"
else
  not_ok ".env has non-empty PREVIEW_DB_PASSWORD"
fi

PWD_IN_PREVIEW="$(sed -n 's/.*:\(.*\)@postgres-preview.*/\1/p' "${OUT1}/preview-db.env" | head -1)"
if [ -n "$PWD_IN_PREVIEW" ]; then
  ok "preview-db.env has non-empty password in DATABASE_URL"
else
  not_ok "preview-db.env has non-empty password in DATABASE_URL"
fi

# Passwords must match between the two files.
if [ "$PWD_IN_ENV" = "$PWD_IN_PREVIEW" ]; then
  ok "password matches between .env and preview-db.env"
else
  not_ok "password matches between .env and preview-db.env"
fi

# Generated password must contain no '$' (compose-safe) and be base64-alphanumeric.
if [[ "$PWD_IN_ENV" != *'$'* ]]; then
  ok "generated password contains no '$'"
else
  not_ok "generated password contains no '$'"
fi
if [[ "$PWD_IN_ENV" =~ ^[A-Za-z0-9]+$ ]]; then
  ok "generated password is base64-alphanumeric (no /+=)"
else
  not_ok "generated password is base64-alphanumeric (no /+=)"
fi

# ── Test 2: Reuse — PREVIEW_DB_PASSWORD set → written back unchanged ────────
printf '\n--- reuse: PREVIEW_DB_PASSWORD set → unchanged ---\n'
OUT2="${TMP}/out2"
EXISTING_PWD="AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
WITH_PASSWORD=1 PASSWORD_VALUE="$EXISTING_PWD" run_render "$OUT2"
PWD_REUSED="$(sed -n 's/^PREVIEW_DB_PASSWORD=//p' "${OUT2}/.env")"
if [ "$PWD_REUSED" = "$EXISTING_PWD" ]; then
  ok "PREVIEW_DB_PASSWORD reused unchanged (len=${#PWD_REUSED})"
else
  not_ok "PREVIEW_DB_PASSWORD reused unchanged (got '$PWD_REUSED', expected '$EXISTING_PWD')"
fi

# ── Test 3: Empty input — PREVIEW_DB_PASSWORD="" → generates one ────────────
printf '\n--- empty input: PREVIEW_DB_PASSWORD="" ---\n'
OUT3="${TMP}/out3"
WITH_PASSWORD=1 PASSWORD_VALUE="" run_render "$OUT3"
PWD_EMPTY="$(sed -n 's/^PREVIEW_DB_PASSWORD=//p' "${OUT3}/.env")"
if [ -n "$PWD_EMPTY" ]; then
  ok "empty PREVIEW_DB_PASSWORD replaced with generated one (len=${#PWD_EMPTY})"
else
  not_ok "empty PREVIEW_DB_PASSWORD replaced with generated one"
fi

# ── Test 4: Second render with the generated password writes it back ─────────
printf '\n--- regression: second render with generated password → unchanged ---\n'
OUT4="${TMP}/out4"
# First render with no password → generates one.
WITH_PASSWORD= run_render "$OUT4"
FIRST_PWD="$(sed -n 's/^PREVIEW_DB_PASSWORD=//p' "${OUT4}/.env")"
# Second render with that password → writes it back unchanged.
OUT4B="${TMP}/out4b"
WITH_PASSWORD=1 PASSWORD_VALUE="$FIRST_PWD" run_render "$OUT4B"
SECOND_PWD="$(sed -n 's/^PREVIEW_DB_PASSWORD=//p' "${OUT4B}/.env")"
if [ "$SECOND_PWD" = "$FIRST_PWD" ]; then
  ok "second render writes PREVIEW_DB_PASSWORD back unchanged"
else
  not_ok "second render writes PREVIEW_DB_PASSWORD back unchanged"
fi

# ── Test 5: Boundary — generated password length bounds ────────────────────
printf '\n--- boundary: generated password length ---\n'
PWD_LEN=${#PWD_IN_ENV}
if [ "$PWD_LEN" -ge 1 ] && [ "$PWD_LEN" -le 32 ]; then
  ok "generated password length within [1, 32] (len=$PWD_LEN)"
else
  not_ok "generated password length within [1, 32] (len=$PWD_LEN)"
fi
if [ "$PWD_LEN" -gt 0 ]; then
  ok "lower bound 0 rejected: password is non-empty"
else
  not_ok "lower bound 0 rejected: password is non-empty"
fi

# ── Test 6: Concurrency — two simultaneous renders both succeed ────────────
printf '\n--- concurrency: two simultaneous renders ---\n'
OUT5="${TMP}/out5"
OUT6="${TMP}/out6"
RC5=0 RC6=0
( WITH_PASSWORD= run_render "$OUT5" ) & PID5=$!
( WITH_PASSWORD= run_render "$OUT6" ) & PID6=$!
wait "$PID5" || RC5=$?
wait "$PID6" || RC6=$?
if [ "$RC5" -eq 0 ] && [ "$RC6" -eq 0 ]; then
  ok "concurrent renders both exited 0"
else
  not_ok "concurrent renders both exited 0 (rc=$RC5/$RC6)"
fi
PWD5="$(sed -n 's/^PREVIEW_DB_PASSWORD=//p' "${OUT5}/.env")"
PWD6="$(sed -n 's/^PREVIEW_DB_PASSWORD=//p' "${OUT6}/.env")"
if [ -n "$PWD5" ] && [ -n "$PWD6" ]; then
  ok "concurrent renders each produced a non-empty password"
else
  not_ok "concurrent renders each produced a non-empty password"
fi

# ── Test 7: Negative — missing output directory → usage refusal ─────────────
printf '\n--- negative: missing output directory ---\n'
set +e
"${RENDER_SCRIPT}" >"${TMP}/negative.stdout" 2>"${TMP}/negative.stderr"
NEG_RC=$?
set -e
if [ "$NEG_RC" -ne 0 ] && grep -qi "usage" "${TMP}/negative.stderr"; then
  ok "missing output directory is refused with a usage error (rc=$NEG_RC)"
else
  not_ok "missing output directory is refused with a usage error (rc=$NEG_RC)"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
printf '\n--- results: %d passed, %d failed ---\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0