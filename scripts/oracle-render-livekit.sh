#!/usr/bin/env bash
# Render livekit.yaml, egress.yaml and the stack .env from Infisical.
#
# Called by scripts/oracle-deploy.sh; usable on its own to see what would be
# written. Takes one argument: a directory to write into.
#
# ⚠️ These three files carry the LiveKit key pair and land on the box at mode
# 600. Nothing here is committed, and nothing here should be edited on the box
# — the previous box's copies were hand-edited with `.bak` files beside them
# as the only history, and that is how two URLs went stale through the D-138
# rename and took captions and webhooks down through a real class.
set -euo pipefail

OUT="${1:?usage: oracle-render-livekit.sh <output-dir>}"
# ⚠️ No fallback default — see D-158. The environment, then the gitignored
# project link, then a loud failure.
INFISICAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../infra/infisical" && pwd)"
# shellcheck source=../infra/infisical/infisical.sh
source "${INFISICAL_DIR}/infisical.sh"

# ⚠️ THE PRODUCTION APP IS NOT ON THIS BOX, so both of these leave it.
#
# The production web app stays on Fly and production's database stays on Neon
# (D-150's second addendum, 2026-09-04); Oracle carries LiveKit, preview and
# preview's Postgres. So the captions agent and livekit-server both call the
# app out through Cloudflare, which is the path that broke on 2026-08-30 —
# and the important part of that outage is WHICH half caused it. The D-138
# rename swept 934 files in this repository and could not touch the box, so
# both values sat on `agendaprofe.com`; the 301 turned the agent's POST into a
# GET, it got a 405, discovery.ts started no RoomWorker, and one real class ran
# with subtitles silently dead. livekit-server's webhooks failed the same way
# while its own log kept saying `sent webhook`, because a 301 looks like
# success. The fault was a stale hostname that nothing in the repository
# owned — not the fact that the request left the machine.
#
# ⚠️ So the two defences are: this value is RENDERED here, from one place a
# rename sweep can reach, and never hand-edited on the box; and
# scripts/oracle-deploy.sh probes it after every deploy and FAILS on any 3xx.
# Do not remove that probe, and do not set this to a hostname Cloudflare
# redirects — a redirect is invisible everywhere else, because it looks
# exactly like a delivered webhook.
APP_INTERNAL_BASE_URL="${APP_INTERNAL_BASE_URL:-https://spiralclass.com}"
LIVEKIT_WEBHOOK_URL="${LIVEKIT_WEBHOOK_URL:-${APP_INTERNAL_BASE_URL}/api/livekit/webhook}"

mkdir -p "$OUT"
chmod 700 "$OUT"

secret() {
  infisical_secrets --path="${2:-/}" --plain production "$1" || {
    echo "oracle-render-livekit: $1 not found in Infisical ${2:-/}" >&2
    exit 1
  }
}

LIVEKIT_API_KEY="$(secret LIVEKIT_API_KEY /config)"
LIVEKIT_API_SECRET="$(secret LIVEKIT_API_SECRET /)"
DEEPGRAM_API_KEY="$(secret DEEPGRAM_API_KEY /)"
ANTHROPIC_API_KEY="$(secret ANTHROPIC_API_KEY /)"
CAPTIONS_AGENT_SHARED_SECRET="$(secret CAPTIONS_AGENT_SHARED_SECRET /)"

# ⚠️ The old module read LIVEKIT_API_KEY out of
# config/env/production.runtime.env with a regex(). That value is the literal
# string `__LOCAL__` — the nine runtime values moved to Infisical — so
# applying it would have written `__LOCAL__` as LiveKit's API key and every
# token would have failed to verify, with nothing in any log saying why.
# Guard against the same class of mistake from any source.
for v in LIVEKIT_API_KEY LIVEKIT_API_SECRET DEEPGRAM_API_KEY \
         ANTHROPIC_API_KEY CAPTIONS_AGENT_SHARED_SECRET; do
  case "${!v}" in
    ""|__LOCAL__) echo "oracle-render-livekit: $v is empty or __LOCAL__" >&2; exit 1 ;;
  esac
done

umask 077

# ⚠️ ONLY FOR THE COMPOSE `.env` FILE. Compose INTERPOLATES that file: a `$` in
# a value is read as a variable reference and expands to the empty string, so
# `ab$cd+ef` reaches the container as `ab+ef`. Verified against Compose 5.4.0
# on 2026-09-04, and `$$` is the escape that survives as a literal `$`.
#
# The damage is worse than one mangled value, because LIVEKIT_API_SECRET
# travels TWO paths out of this script from ONE source: an unquoted shell
# heredoc into livekit.yaml (no compose anywhere) and this file into the
# captions agent (compose interpolation). A `$` corrupts the second and not
# the first, so livekit-server holds the right secret while the captions agent
# authenticates with a different one — which presents as captions silently
# dead, the same symptom as 2026-08-30 and a different cause.
#
# ⚠️ Do NOT apply this to livekit.yaml, egress.yaml or preview-db.env. Those
# are read by LiveKit and by `env_file:`, neither of which interpolates, so an
# escaped `$$` would arrive as a literal `$$`.
env_escape() { printf '%s' "$1" | sed 's/\$/$$/g'; }

cat > "$OUT/livekit.yaml" <<EOF
port: 7880

rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true

turn:
  enabled: true
  udp_port: 3478
  external_tls: false
  relay_range_start: 50000
  relay_range_end: 60000

redis:
  address: 127.0.0.1:6379

keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}

webhook:
  api_key: ${LIVEKIT_API_KEY}
  urls:
    - ${LIVEKIT_WEBHOOK_URL}
EOF

cat > "$OUT/egress.yaml" <<EOF
ws_url: ws://127.0.0.1:7880
api_key: ${LIVEKIT_API_KEY}
api_secret: ${LIVEKIT_API_SECRET}
redis:
  address: 127.0.0.1:6379
cpu_cost:
  # ⚠️ 2, because that is what the box actually ran. Verified against the
  # captured egress.yaml rather than reasoned about — an earlier draft of this
  # script invented \`audio_room_composite_cpu_cost\`, which is not a key
  # LiveKit egress reads, so it would have been silently ignored and the
  # default restored without anything saying so.
  #
  # It means egress reserves 2 of this box's 2 OCPUs for one composite. That
  # is egress refusing to run two at once, which on this machine is correct:
  # D-131 records it wanting 4 OCPUs, and one 51-minute class produced an
  # 846 MB file and dropped 2,586 frames before D-135 made recordings
  # audio-only.
  room_composite_cpu_cost: 2
EOF

# ⚠️ Preview's Postgres credentials belong in THIS file, because compose reads
# `.env` from the project directory for ${...} substitution — `env_file:` does
# not feed substitution, and the shell environment passed over ssh carries only
# the image names.
#
# Omitting them does not fail loudly. Compose warns, sets POSTGRES_PASSWORD to
# the empty string, and the postgres entrypoint exits 1 with "Database is
# uninitialized and superuser password is not specified" — then restart-loops.
# `docker ps` lists a restarting container, so a presence check still passes.
PREVIEW_DB_USER="${PREVIEW_DB_USER:-spiralclass_preview}"
PREVIEW_DB_NAME="${PREVIEW_DB_NAME:-spiralclass_preview}"

cat > "$OUT/.env" <<EOF
LIVEKIT_API_KEY=$(env_escape "$LIVEKIT_API_KEY")
LIVEKIT_API_SECRET=$(env_escape "$LIVEKIT_API_SECRET")
DEEPGRAM_API_KEY=$(env_escape "$DEEPGRAM_API_KEY")
ANTHROPIC_API_KEY=$(env_escape "$ANTHROPIC_API_KEY")
CAPTIONS_AGENT_SHARED_SECRET=$(env_escape "$CAPTIONS_AGENT_SHARED_SECRET")
APP_INTERNAL_BASE_URL=$(env_escape "$APP_INTERNAL_BASE_URL")
PREVIEW_DB_USER=$(env_escape "$PREVIEW_DB_USER")
PREVIEW_DB_PASSWORD=$(env_escape "$PREVIEW_DB_PASSWORD")
PREVIEW_DB_NAME=$(env_escape "$PREVIEW_DB_NAME")
EOF

# The preview app's own connection string, written where oracle-deploy.sh can
# append it to preview.app.env. ⚠️ Without this the preview app keeps the Neon
# URL it gets from Infisical, and the Postgres container on this box is
# provisioned, published and completely unused.
cat > "$OUT/preview-db.env" <<EOF
DATABASE_URL=postgresql://${PREVIEW_DB_USER}:${PREVIEW_DB_PASSWORD}@postgres-preview:5432/${PREVIEW_DB_NAME}
DIRECT_URL=postgresql://${PREVIEW_DB_USER}:${PREVIEW_DB_PASSWORD}@postgres-preview:5432/${PREVIEW_DB_NAME}
EOF
chmod 600 "$OUT/preview-db.env"

chmod 600 "$OUT/livekit.yaml" "$OUT/egress.yaml" "$OUT/.env"
echo "rendered livekit.yaml, egress.yaml and .env into $OUT"
echo "  APP_INTERNAL_BASE_URL = ${APP_INTERNAL_BASE_URL}"
echo "  webhook url           = ${LIVEKIT_WEBHOOK_URL}"
