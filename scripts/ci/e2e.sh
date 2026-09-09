#!/usr/bin/env bash
# The Playwright browser suites: happy-path E2E, visual regression and axe. Was .github/workflows/e2e.yml until
# D-119 mirrored it here and D-129 deleted the workflow; this is the only copy.
#
# Boots the same stack the workflow does — postgres:16, migrations, the Alicia
# Moreno seed, a PRODUCTION build served by `next start` — and runs the full
# Playwright suite (E2E_EXTENDED=1) against it. Every run gets a fresh
# `spiralclass_e2e` database, so the determinism the workflow got from a
# throwaway service container is preserved here.
#
# The DB lives in the same docker-compose.test.yml container the integration
# step uses (port 5433), just in its own database — one container to babysit
# instead of two.
#
# APP_URL is a *.localhost host on purpose: prod-vs-preview is decided by
# APP_URL (D-89 Phase 5 removed the VERCEL_ENV branch), so the app must see a
# preview-shaped origin. Chromium maps *.localhost to loopback itself; the
# readiness probe below uses 127.0.0.1 so it doesn't depend on the OS resolver
# agreeing.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Serialize against every other checkout on this machine (D-146). This suite
# holds three singletons for its whole duration: the shared
# `spiralclass-test-db` container, port 3000, and a production `next build`
# with a 6GB heap ceiling followed by a fleet of Chromium workers. The port
# guard further down already treats a second server on 3000 as a correctness
# problem rather than an inconvenience — this is that same argument applied one
# level up, so the second run never starts instead of racing and then being
# detected.
#
# Taken here rather than only in gate.mjs so a hand-run is covered too; a pass
# through when the gate already owns the machine (see scripts/ci/lock.mjs).
if [ "${SPIRALCLASS_LOCK_INNER:-}" != "1" ]; then
  exec env SPIRALCLASS_LOCK_INNER=1 \
    node scripts/ci/lock.mjs run --label "e2e" -- bash "$0" "$@"
fi

COMPOSE=(docker compose -f apps/web/docker-compose.test.yml)

E2E_DATABASE_URL="postgresql://test:test@localhost:5433/spiralclass_e2e"
export DATABASE_URL="$E2E_DATABASE_URL"
export DIRECT_URL="$E2E_DATABASE_URL"
export APP_URL="http://preview.localhost:3000"
export PLAYWRIGHT_BASE_URL="http://preview.localhost:3000"
export SESSION_SECRET="e2e-local-session-secret-ephemeral"

PORT=3000
APP_LOG="${TMPDIR:-/tmp}/spiralclass-e2e-app.log"
APP_PID=""

# Guard against the failure mode where a leftover `next dev`/`next start`
# from an earlier session is already squatting $PORT: the readiness probe
# below only checks that *something* answers on the port, so it would happily
# report success against that stale process. The suite would then run against
# a server whose chunk manifest doesn't match the fresh build this script just
# wrote to .next/static — hydration breaks, and every OTP-driven sign-in spec
# times out identically, looking like a product bug when it's actually a
# contaminated port (this happened for real: a two-hour-old stray `next
# start -p 3000` caused exactly that 11-spec failure, silently, until someone
# traced two 400s on hashed chunk files back to it).
#
# Default is fail-fast, not auto-kill: the PID on $PORT might not even be
# ours to kill (another project, another person's process on a shared box).
# Auto-kill only when E2E_KILL_PORT_HOG=1 is set, and even then only for a
# PID whose cwd is one of THIS repo's own apps/web directories.
#
# "This repo" means every worktree, not just the current one. It used to mean
# `git rev-parse --show-toplevel`, which inside a worktree is that worktree —
# so the flag could only ever kill a stray started from the same checkout.
# D-146 says several Claude sessions work this repo at once, each in its own
# worktree, all sharing one laptop; the port-3000 collision that actually
# happens is therefore between SIBLING worktrees, and that is the single case
# the escape hatch could not reach. Observed 2026-09-01: three consecutive
# `ship:preview --gate` runs died here, with E2E_KILL_PORT_HOG=1 set on the
# last two, against a dev server in a sibling worktree.
#
# Widening it does NOT make killing safe — the process may belong to a live
# session mid-task (on 2026-09-01 one was killed on the assumption it was
# abandoned, and the session that owned it started a new one six minutes
# later). So the flag stays opt-in, and both branches below now NAME the
# worktree the process belongs to, which is the fact you need to tell "my
# leftover" from "someone else's work in progress".
existing_pid="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
if [ -n "$existing_pid" ]; then
  existing_cmd="$(ps -p "$existing_pid" -o command= 2>/dev/null || echo "unknown")"
  existing_cwd="$(lsof -p "$existing_pid" 2>/dev/null | awk '$4=="cwd"{print $NF}')"
  # Every worktree of this repo, as the apps/web path a dev server runs from.
  # `git worktree list --porcelain` includes the main checkout, so this is a
  # superset of the old single-root check and never a different set.
  repo_web_dirs="$(git worktree list --porcelain 2>/dev/null \
    | awk '/^worktree /{ $1=""; sub(/^ /,""); print $0"/apps/web" }')"
  if [ -n "$existing_cwd" ] && printf '%s\n' "$repo_web_dirs" | grep -Fxq "$existing_cwd"; then
    # .../<worktree>/apps/web -> <worktree>. The main checkout is a worktree
    # too as far as git is concerned, but calling it one in the message would
    # read oddly, so it gets named for what it is.
    owner_root="$(dirname "$(dirname "$existing_cwd")")"
    main_root="$(dirname "$(git rev-parse --git-common-dir 2>/dev/null)")"
    if [ "$owner_root" = "$main_root" ]; then
      owner="the main checkout"
    else
      owner="the $(basename "$owner_root") worktree"
    fi
  else
    owner=""
  fi
  if [ "${E2E_KILL_PORT_HOG:-}" = "1" ] && [ -n "$owner" ]; then
    echo "── Port ${PORT} already in use (pid ${existing_pid}, ${owner}): ${existing_cmd}"
    echo "   E2E_KILL_PORT_HOG=1 set and it belongs to this repo — killing it."
    echo "   If ${owner} is not yours, that session just lost its dev server."
    kill "$existing_pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$existing_pid" 2>/dev/null || break
      sleep 0.5
    done
  else
    echo "Port ${PORT} is already in use by pid ${existing_pid} (cwd: ${existing_cwd:-unknown}):"
    echo "  ${existing_cmd}"
    echo ""
    if [ -n "$owner" ]; then
      echo "It belongs to ${owner} of this repo — quite possibly another session"
      echo "working right now, which is why it is not killed by default."
    else
      echo "It is NOT one of this repo's worktrees, so it will not be killed even"
      echo "with E2E_KILL_PORT_HOG=1."
    fi
    echo ""
    echo "This script needs $PORT free — a leftover process here would silently"
    echo "serve stale assets against the fresh build below, not fail loudly."
    if [ -n "$owner" ]; then
      echo "Stop it, or re-run with E2E_KILL_PORT_HOG=1 to auto-kill it."
    else
      echo "Stop it yourself and re-run."
    fi
    exit 1
  fi
fi

cleanup() {
  [ -n "$APP_PID" ] || return 0
  # Signal the whole process GROUP, not just $APP_PID. `pnpm exec next start`
  # spawns next-server as a grandchild, so $APP_PID is the wrapper: killing it
  # alone reaped the wrapper instantly and left the process actually bound to
  # $PORT running forever. That orphan is what the port guard at the top of this
  # file reports on the NEXT run — a failure that reads as "someone left a dev
  # server open" when in truth this script leaked its own. A negative PID means
  # "the group", which is what `set -m` below buys us.
  if kill -0 "$APP_PID" 2>/dev/null || pgrep -g "$APP_PID" >/dev/null 2>&1; then
    echo "── Stopping app (process group ${APP_PID})"
    kill -- -"$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      pgrep -g "$APP_PID" >/dev/null 2>&1 || break
      sleep 0.5
    done
    # Escalate rather than return with the port still held: exiting quietly here
    # hands the next run the exact failure this cleanup exists to prevent.
    if pgrep -g "$APP_PID" >/dev/null 2>&1; then
      echo "   still alive after 10s — SIGKILL"
      kill -9 -- -"$APP_PID" 2>/dev/null || true
    fi
    wait "$APP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "── Postgres (docker compose, port 5433)"
"${COMPOSE[@]}" up -d --wait

echo "── Fresh e2e database"
psql_root() { "${COMPOSE[@]}" exec -T test-db psql -U test -d postgres -v ON_ERROR_STOP=1 "$@"; }
psql_root -c 'DROP DATABASE IF EXISTS spiralclass_e2e WITH (FORCE)' >/dev/null
psql_root -c 'CREATE DATABASE spiralclass_e2e' >/dev/null

echo "── Apply migrations"
pnpm --filter spiralclass-web exec prisma migrate deploy

echo "── Seed"
(cd apps/web && pnpm exec tsx scripts/seed.ts)

echo "── Playwright browser"
# --with-deps installs the Linux system libraries Chromium needs (libnss3,
# libasound2 and friends) and is a no-op-with-error on macOS, so it is chosen
# by platform rather than passed unconditionally ([D-161]). Re-running when
# Chromium is already present is cheap on both.
if [ "$(uname -s)" = "Linux" ]; then
  pnpm --filter spiralclass-web exec playwright install --with-deps chromium
else
  pnpm --filter spiralclass-web exec playwright install chromium
fi

echo "── Production build"
(
  cd apps/web
  E2E_STRIPE_STUB=1 NODE_OPTIONS="--max-old-space-size=6144" \
    pnpm exec next build --turbopack
)

echo "── Start app"
# `set -m` (job control) puts this background job in its OWN process group, with
# pgid == $!. Without it the job inherits this script's group, and cleanup's
# `kill -- -$APP_PID` would either fail or, worse, signal the whole gate run.
# Job control is turned straight back off: it is needed to create the group, not
# to run the suite.
set -m
(
  cd apps/web
  E2E_STRIPE_STUB=1 E2E_RATE_LIMIT_BYPASS=1 pnpm exec next start -p "$PORT" >"$APP_LOG" 2>&1
) &
APP_PID=$!
set +m

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT}" >/dev/null; then
    echo "App is up."
    break
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "  The app exited before it became ready. Last 100 log lines:"
    tail -n 100 "$APP_LOG"
    exit 1
  fi
  sleep 2
done

if ! curl -sf "http://127.0.0.1:${PORT}" >/dev/null; then
  echo "  App never became ready. Last 100 log lines:"
  tail -n 100 "$APP_LOG"
  exit 1
fi

# The suite drives Chromium at preview.localhost; if the OS resolver can't see
# that host, every spec fails with a DNS error that looks nothing like the cause.
if ! node -e 'require("node:dns").lookup("preview.localhost", (e) => process.exit(e ? 1 : 0))'; then
  echo ""
  echo "  preview.localhost does not resolve on this machine."
  echo "  Fix:  echo '127.0.0.1 preview.localhost' | sudo tee -a /etc/hosts"
  echo ""
  echo "  macOS resolves *.localhost through mDNSResponder; glibc does not, so a"
  echo "  Linux runner needs the hosts entry written before this script runs."
  echo "  .github/workflows/heavy.yml does exactly that, in a step of its own."
  exit 1
fi

echo "── E2E suite (extended)"
set +e
CI=1 PLAYWRIGHT_NO_WEBSERVER=1 E2E_EXTENDED=1 pnpm --filter spiralclass-web test:e2e
E2E_STATUS=$?

# The visual-regression and accessibility suites, against the SAME stack.
#
# They were not in the gate at all until now, which is how the visual baselines
# went red on main three separate times without anyone noticing — after #917
# and #922 changed the booking page, and again after #943 changed the checkout
# copy. Each time the suite was only discovered red because someone ran it by
# hand. A guard nobody runs is a file, not a guard.
#
# They live HERE rather than in steps of their own because the expensive part is
# the production build and the seeded database, and this script has already
# paid for both. A separate step would have meant a second `next build`
# (~3.5GB peak, minutes) to check the same server. The cost of adding them is
# about ninety seconds.
#
# Reported separately so a failure names itself: "visual" and "a11y" rather
# than a bare "e2e failed" pointing at a suite that passed.
#
# VISUAL_UPDATE_SNAPSHOTS=1 rewrites the baselines instead of asserting them.
# There was no supported way to do that, which is the other half of why the
# baselines kept rotting: the suite runs against THIS script's seeded stack and
# production build, so a baseline regenerated any other way — against the
# deployed preview, say, which is what the config's default baseURL points at —
# photographs the wrong code and looks like it worked. Deliberately an env var
# rather than a flag, because it must never be reachable from `pnpm gate`.
# The value is the ROUTE FILTER, not a boolean:
#
#   VISUAL_UPDATE_SNAPSHOTS=booking bash scripts/ci/e2e.sh
#
# Both halves of that are load-bearing, and each was learned the hard way while
# regenerating for D-144:
#
#   `=all` rather than a bare `--update-snapshots` (which means "changed"),
#   because the suite tolerates maxDiffPixelRatio 0.01 for font rasterisation
#   and cannot tell a pixel of antialiasing from a real edit smaller than that.
#   Two lines of grey text swapping places on a 1280x2184 page is about 0.003:
#   it PASSES against the stale baseline, so "changed" writes nothing and the
#   committed image keeps showing a layout that no longer ships. Three
#   regeneration runs in a row silently did nothing for exactly this reason.
#
#   ...but `=all` on its own rewrites every byte of all ~130 images, including
#   the routes you never touched, because that same sub-tolerance noise differs
#   run to run. That re-baselines the whole suite onto one machine's font
#   rendering and buries the two files you actually changed. So it is scoped
#   with -g to the routes under test.
#
# Pass `all` deliberately to rewrite everything (a token change with real blast
# radius); anything else is a Playwright -g pattern matched against test titles,
# which are "<route name> matches its baseline".
#
# ⚠️ THERE ARE TWO BASELINE SETS AND THIS SCRIPT ONLY EVER WRITES ONE OF THEM.
# Playwright suffixes a snapshot with `process.platform`, so the committed
# images are `-darwin.png` (120 of them) AND `-linux.png` (120 more, added by
# [D-161] so the browser suites could leave the laptop). A regeneration run
# rewrites the set belonging to the machine it runs on and cannot see the
# other, which makes the failure mode concrete and worth naming: regenerate on
# the laptop, commit, and the runner goes red on the same 120 routes it was
# always going to go red on — because nothing regenerated ITS set.
#
# So a change to what a page LOOKS LIKE needs both, and the supported way to
# get the Linux half is not to run this script under emulation (arm64 Linux
# rasterises text differently from the amd64 runner, so those images would be
# wrong in a way that passes locally and fails in CI). It is:
#
#   gh workflow run heavy.yml -f update_visual_baselines=all --ref <branch>
#
# which runs this script on `ubuntu-latest`, then uploads the rewritten
# `-linux.png` files as an artifact for you to download and commit. The
# workflow header spells out the download step.
VISUAL_UPDATE=()
if [ -n "${VISUAL_UPDATE_SNAPSHOTS:-}" ]; then
  VISUAL_UPDATE=(--update-snapshots=all)
  if [ "$VISUAL_UPDATE_SNAPSHOTS" != "all" ]; then
    VISUAL_UPDATE+=(-g "$VISUAL_UPDATE_SNAPSHOTS")
  fi
  echo ""
  echo "── VISUAL_UPDATE_SNAPSHOTS=${VISUAL_UPDATE_SNAPSHOTS} — REWRITING baselines, not asserting them."
  if [ "$VISUAL_UPDATE_SNAPSHOTS" = "all" ]; then
    echo "   EVERY route, including ones you did not touch. Expect ~130 changed"
    echo "   files and check that you meant that before committing."
  else
    echo "   Scoped to routes matching /${VISUAL_UPDATE_SNAPSHOTS}/."
  fi
  echo "   Review the resulting diff image by image; that review is the guard."
fi

echo ""
echo "── Visual regression (portfolio routes, 6 viewports x 2 themes)"
set +e
# overflow.spec.ts rides along in the same invocation because it wants exactly
# this matrix — the same routes at the same twelve combinations — and the
# expensive part is already paid for. It owns no images, so an update run
# passes over it untouched: a scoped `-g` filters it out by title, and `=all`
# simply re-asserts it, which is the right answer anyway. Do not regenerate a
# baseline of a page that scrolls sideways.
CI=1 VISUAL_BASE_URL="$APP_URL" pnpm --filter spiralclass-web exec playwright test \
  --config playwright.visual.config.ts tests/visual/regression.spec.ts tests/visual/overflow.spec.ts --reporter=line \
  ${VISUAL_UPDATE[@]+"${VISUAL_UPDATE[@]}"}
VISUAL_STATUS=$?

echo ""
echo "── Accessibility (axe, public and authenticated, both locales, light + dark)"
CI=1 VISUAL_BASE_URL="$APP_URL" A11Y_BASE_URL="$APP_URL" \
  pnpm --filter spiralclass-web exec playwright test \
  --config playwright.a11y.config.ts --reporter=line
A11Y_STATUS=$?
set -e

# Any of the three failing fails the step, and the summary says which — a
# single exit code that could mean any of them is how "green" stops meaning
# anything.
if [ "$E2E_STATUS" -ne 0 ] || [ "$VISUAL_STATUS" -ne 0 ] || [ "$A11Y_STATUS" -ne 0 ]; then
  echo ""
  echo "  e2e=${E2E_STATUS}  visual=${VISUAL_STATUS}  a11y=${A11Y_STATUS}  (0 = passed)"
fi
[ "$E2E_STATUS" -eq 0 ] || FINAL_STATUS=$E2E_STATUS
[ "${FINAL_STATUS:-0}" -ne 0 ] || [ "$VISUAL_STATUS" -eq 0 ] || FINAL_STATUS=$VISUAL_STATUS
[ "${FINAL_STATUS:-0}" -ne 0 ] || [ "$A11Y_STATUS" -eq 0 ] || FINAL_STATUS=$A11Y_STATUS
E2E_STATUS=${FINAL_STATUS:-0}
set -e

if [ "$E2E_STATUS" -ne 0 ]; then
  echo ""
  echo "  Last 200 app log lines (${APP_LOG}):"
  tail -n 200 "$APP_LOG"
  echo ""
  echo "  HTML report: apps/web/playwright-report/index.html"
  echo "  Open it with: pnpm --filter spiralclass-web exec playwright show-report"
fi

exit "$E2E_STATUS"
