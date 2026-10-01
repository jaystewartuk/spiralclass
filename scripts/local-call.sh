#!/usr/bin/env bash
# A teacher and a student in one video call, on this laptop, in Chrome.
#
# The hermetic E2E suite deliberately leaves the call out (it needs two live
# participants and a media stack — docs/development/testing.md), so a change
# to the call screen is seen by hand. This is that by-hand setup, with every
# trap that cost a session an hour already stepped around. Each one is named
# where it is handled below; the doc section "The video call, by hand" has the
# why.
#
# Usage:
#   pnpm call:local                          # Alicia teaches Carlos, class starting now
#   pnpm call:local --student maria@alumno.test
#   pnpm call:local --no-build               # reuse the last build (env changes need no rebuild)
#   pnpm call:local --seed                   # re-seed first (wipes local edits to seed rows)
#   pnpm call:local code <email>             # after "Email me a code": makes the code 424242
#
# Then, in Chrome: the teacher at http://localhost:3000, the student at
# http://preview.localhost:3000 — two hosts, so two separate sign-ins.
#
# Local only: it refuses any database but the dev container.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TEACHER="alicia.moreno@spiralclass.test"
STUDENT="carlos@alumno.test"
CODE="424242"
DB_CONTAINER="spiralclass-dev-db"
LIVEKIT_CONTAINER="spiralclass-livekit-dev"
BUILD=1
SEED=0

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
# Single statements only: `psql -c "a; b"` runs as ONE transaction, so a
# failure in b silently rolls back a — a "done" update that never happened.
sql() { docker exec -i "$DB_CONTAINER" psql -U postgres -d spiralclass -v ON_ERROR_STOP=1 -qAtc "$1"; }
safe_email() { [[ "$1" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || die "not an email: $1"; }

# --- `code`: sign in without reading an email -------------------------------
# A production build's stub mailer logs that it sent nothing, not the code
# (only `next dev` prints the email). The code is stored hashed, so plant a
# known one over the real send — exactly what tests/e2e/_helpers/better-auth.ts
# does.
if [ "${1:-}" = "code" ]; then
  email="$(printf '%s' "${2:?usage: pnpm call:local code <email>}" | tr '[:upper:]' '[:lower:]')"
  safe_email "$email"
  hash="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("base64url"))' "$CODE")"
  rows="$(sql "update verification set value='${hash}:0', \"expiresAt\"=now()+interval '10 minutes' where identifier='sign-in-otp-${email}' returning 1" | grep -c 1 || true)"
  [ "$rows" -gt 0 ] || die "no code pending for ${email} — click \"Email me a code\" first, then re-run this"
  echo "Type ${CODE} as ${email}'s code."
  exit 0
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --student) STUDENT="$(printf '%s' "${2:?--student needs an email}" | tr '[:upper:]' '[:lower:]')"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --seed) SEED=1; shift ;;
    *) die "unknown option: $1 (see the header of scripts/local-call.sh)" ;;
  esac
done
safe_email "$STUDENT"

step "Checking the machine"
docker info >/dev/null 2>&1 || die "docker is not running."
if lsof -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  die "port 3000 is taken (another session's pnpm dev or E2E run?). Stop it, or wait — see \`pnpm gate:lock\`."
fi
echo "  ok"

step "Database: up, migrated$([ "$SEED" = 1 ] && echo ", re-seeded")"
pnpm --filter spiralclass-web db:dev:up >/dev/null
pnpm --filter spiralclass-web prisma:migrate:deploy >/dev/null
if [ "$SEED" = 1 ] || [ -z "$(sql "select 1 from teachers where email='${TEACHER}'")" ]; then
  pnpm --filter spiralclass-web seed | tail -3
fi

step "LiveKit dev server on :7880"
# --node-ip 127.0.0.1: inside Docker on a Mac, LiveKit advertises the
# container's own address for media. Both browsers then reach signalling, ICE
# never connects, and LiveKit logs "removing participant without connection"
# while the page sits on "Connecting…".
if [ -z "$(docker ps -q -f "name=^${LIVEKIT_CONTAINER}$")" ]; then
  docker rm -f "$LIVEKIT_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$LIVEKIT_CONTAINER" -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
    livekit/livekit-server:latest --dev --bind 0.0.0.0 --node-ip 127.0.0.1 >/dev/null
fi
# A loop, not `curl --retry`: while LiveKit boots, Docker's port forward
# answers with an empty reply, which curl does not count as retryable.
for _ in $(seq 1 30); do
  curl -sf -o /dev/null http://localhost:7880/ && break
  sleep 1
done
curl -sf -o /dev/null http://localhost:7880/ || die "LiveKit did not come up — docker logs ${LIVEKIT_CONTAINER}"
echo "  ok"

step "A class between ${TEACHER} and ${STUDENT}, starting now"
booking="$(sql "select b.id from bookings b join teachers t on t.id=b.teacher_id join students s on s.id=b.student_id where t.email='${TEACHER}' and s.email='${STUDENT}' and b.status='scheduled' order by b.scheduled_start limit 1")"
[ -n "$booking" ] || die "no scheduled class between ${TEACHER} and ${STUDENT} — try --seed, or another --student"
# buffered_end moves with the times: bookings_no_overlap_buffered is an
# exclusion constraint over (scheduled_start, buffered_end).
sql "update bookings set scheduled_start=now()+interval '2 minutes', scheduled_end=now()+interval '52 minutes', buffered_end=now()+interval '52 minutes' where id='${booking}'" >/dev/null \
  || die "could not move the class to now (it overlaps another of the teacher's classes?)"
echo "  booking ${booking}"

# The env a two-person call needs, on top of config/env/local.runtime.env:
#   - a PRODUCTION build: `next dev` blocks its own client scripts for any host
#     but localhost ("Blocked cross-origin request to Next.js dev resource"),
#     so the student's page on preview.localhost never hydrates;
#   - APP_URL on a *preview* host: a production build with a non-preview
#     APP_URL demands production credentials and every request 500s (same
#     trick as scripts/ci/e2e.sh);
#   - CSP_ENFORCE=0: the enforced CSP has no ws://localhost:7880, so the
#     LiveKit socket is refused before it opens;
#   - LiveKit's --dev keys, and captions on. The Translate key is a
#     placeholder: it only has to exist for the toggle to show, and desktop
#     Chrome translates on the device.
export APP_URL="http://preview.localhost:3000"
export CSP_ENFORCE=0
export LIVEKIT_URL="ws://localhost:7880" LIVEKIT_API_KEY="devkey" LIVEKIT_API_SECRET="secret"
export LIVE_CAPTIONS_ENABLED=1 GOOGLE_TRANSLATE_API_KEY="${GOOGLE_TRANSLATE_API_KEY:-local-placeholder}"

if [ "$BUILD" = 1 ] || [ ! -f apps/web/.next/BUILD_ID ]; then
  step "Building (a few minutes; --no-build reuses it next time)"
  (cd apps/web && npx dotenv -e ../../config/env/local.runtime.env -- pnpm build >/dev/null)
fi

cat <<EOF

$(printf '\033[1m')Ready when the server says so. In Chrome:$(printf '\033[0m')
  teacher  http://localhost:3000/dashboard/classes/${booking}/call
  student  http://preview.localhost:3000/my-classes/${booking}/call

  Sign each in at /sign-in on its own host, then: pnpm call:local code <email>
  Turn both cameras off before taking screenshots — it is your webcam.
EOF

step "Serving on :3000 (Ctrl-C stops it; LiveKit keeps running: docker rm -f ${LIVEKIT_CONTAINER})"
cd apps/web
exec pnpm start
